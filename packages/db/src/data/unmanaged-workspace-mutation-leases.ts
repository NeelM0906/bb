import { and, asc, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import {
  environments,
  projects,
  unmanagedWorkspaceMutationLeaseEvents,
  unmanagedWorkspaceMutationLeases,
  unmanagedWorkspaceMutationWaiters,
} from "../schema.js";
import {
  getWorkAdmission,
  markWorkAdmissionRunning,
} from "./work-admissions.js";

export type UnmanagedWorkspaceMutationLeaseRow =
  typeof unmanagedWorkspaceMutationLeases.$inferSelect;
export type UnmanagedWorkspaceMutationLeaseEventRow =
  typeof unmanagedWorkspaceMutationLeaseEvents.$inferSelect;

interface WorkspaceKey {
  canonicalPath: string;
  hostId: string;
}

interface AcquireArgs {
  environmentId: string;
  requestId: string;
  threadId: string;
}

interface AcquireAndStartArgs extends AcquireArgs {
  reservationGeneration: number;
  reservationToken: string;
}

export type AcquireUnmanagedWorkspaceMutationLeaseResult =
  | { outcome: "not-protected" }
  | ({ outcome: "acquired" | "joined"; generation: number } & WorkspaceKey)
  | ({ outcome: "waiting"; holder: UnmanagedWorkspaceMutationLeaseRow } &
      WorkspaceKey);

export type AcquireUnmanagedWorkspaceMutationLeaseAndStartResult =
  | AcquireUnmanagedWorkspaceMutationLeaseResult
  | { outcome: "admission-not-waiting" };

export interface ReleaseUnmanagedWorkspaceMutationLeaseResult {
  released: boolean;
  promoted: UnmanagedWorkspaceMutationLeaseRow | null;
}

function protectedWorkspaceKey(
  db: DbQueryConnection,
  environmentId: string,
): WorkspaceKey | null {
  const target = db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .get();
  if (
    !target ||
    target.path === null ||
    target.workspaceProvisionType !== "unmanaged" ||
    target.status === "destroyed"
  ) {
    return null;
  }
  const optIn = db
    .select({ projectId: projects.id })
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(environments.hostId, target.hostId),
        eq(environments.path, target.path),
        eq(environments.workspaceProvisionType, "unmanaged"),
        ne(environments.status, "destroyed"),
        isNotNull(environments.path),
        eq(projects.protectUnmanagedWorkspace, true),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1)
    .get();
  return optIn ? { canonicalPath: target.path, hostId: target.hostId } : null;
}

export function isUnmanagedWorkspaceMutationProtected(
  db: DbQueryConnection,
  environmentId: string,
): boolean {
  return protectedWorkspaceKey(db, environmentId) !== null;
}

export function hasProtectedUnmanagedWorkspaceOnHost(
  db: DbQueryConnection,
  hostId: string,
): boolean {
  return (
    db
      .select({ projectId: projects.id })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(
        and(
          eq(environments.hostId, hostId),
          eq(environments.workspaceProvisionType, "unmanaged"),
          ne(environments.status, "destroyed"),
          isNotNull(environments.path),
          eq(projects.protectUnmanagedWorkspace, true),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

export function getUnmanagedWorkspaceMutationLease(
  db: DbQueryConnection,
  hostId: string,
  canonicalPath: string,
): UnmanagedWorkspaceMutationLeaseRow | null {
  return (
    db
      .select()
      .from(unmanagedWorkspaceMutationLeases)
      .where(
        and(
          eq(unmanagedWorkspaceMutationLeases.hostId, hostId),
          eq(unmanagedWorkspaceMutationLeases.canonicalPath, canonicalPath),
        ),
      )
      .get() ?? null
  );
}

export function getUnmanagedWorkspaceMutationLeaseForThread(
  db: DbQueryConnection,
  threadId: string,
): UnmanagedWorkspaceMutationLeaseRow | null {
  return (
    db
      .select()
      .from(unmanagedWorkspaceMutationLeases)
      .where(eq(unmanagedWorkspaceMutationLeases.threadId, threadId))
      .limit(1)
      .get() ?? null
  );
}

export function listUnmanagedWorkspaceMutationLeases(
  db: DbQueryConnection,
  args: { hostId?: string } = {},
): UnmanagedWorkspaceMutationLeaseRow[] {
  return db
    .select()
    .from(unmanagedWorkspaceMutationLeases)
    .where(
      args.hostId === undefined
        ? undefined
        : eq(unmanagedWorkspaceMutationLeases.hostId, args.hostId),
    )
    .all();
}

export function getUnmanagedWorkspaceMutationWaitState(
  db: DbQueryConnection,
  requestId: string,
): {
  canonicalPath: string;
  holder: UnmanagedWorkspaceMutationLeaseRow | null;
} | null {
  const waiter = db
    .select()
    .from(unmanagedWorkspaceMutationWaiters)
    .where(
      and(
        eq(unmanagedWorkspaceMutationWaiters.requestId, requestId),
        eq(unmanagedWorkspaceMutationWaiters.state, "waiting"),
      ),
    )
    .get();
  if (!waiter) return null;
  return {
    canonicalPath: waiter.canonicalPath,
    holder: getUnmanagedWorkspaceMutationLease(
      db,
      waiter.hostId,
      waiter.canonicalPath,
    ),
  };
}

function appendEvent(
  tx: DbTransaction,
  args: Omit<typeof unmanagedWorkspaceMutationLeaseEvents.$inferInsert, "id">,
): void {
  tx.insert(unmanagedWorkspaceMutationLeaseEvents).values(args).run();
}

function nextGeneration(tx: DbTransaction, key: WorkspaceKey): number {
  const latest = tx
    .select({ generation: unmanagedWorkspaceMutationLeaseEvents.generation })
    .from(unmanagedWorkspaceMutationLeaseEvents)
    .where(
      and(
        eq(unmanagedWorkspaceMutationLeaseEvents.hostId, key.hostId),
        eq(
          unmanagedWorkspaceMutationLeaseEvents.canonicalPath,
          key.canonicalPath,
        ),
        isNotNull(unmanagedWorkspaceMutationLeaseEvents.generation),
      ),
    )
    .orderBy(desc(unmanagedWorkspaceMutationLeaseEvents.generation))
    .limit(1)
    .get();
  return (latest?.generation ?? 0) + 1;
}

function acquireInTransaction(
  tx: DbTransaction,
  args: AcquireArgs,
): AcquireUnmanagedWorkspaceMutationLeaseResult {
  const key = protectedWorkspaceKey(tx, args.environmentId);
  if (!key) return { outcome: "not-protected" };
  const now = Date.now();
  const holder = getUnmanagedWorkspaceMutationLease(
    tx,
    key.hostId,
    key.canonicalPath,
  );
  if (holder?.threadId === args.threadId) {
    appendEvent(tx, {
      ...key,
      createdAt: now,
      environmentId: args.environmentId,
      generation: holder.generation,
      requestId: args.requestId,
      threadId: args.threadId,
      type: "joined",
    });
    return { ...key, generation: holder.generation, outcome: "joined" };
  }
  if (holder) {
    tx.insert(unmanagedWorkspaceMutationWaiters)
      .values({
        ...key,
        createdAt: now,
        environmentId: args.environmentId,
        requestId: args.requestId,
        state: "waiting",
        threadId: args.threadId,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: unmanagedWorkspaceMutationWaiters.requestId,
      })
      .run();
    appendEvent(tx, {
      ...key,
      createdAt: now,
      environmentId: args.environmentId,
      generation: holder.generation,
      requestId: args.requestId,
      threadId: args.threadId,
      type: "waiting",
    });
    return { ...key, holder, outcome: "waiting" };
  }
  const generation = nextGeneration(tx, key);
  tx.insert(unmanagedWorkspaceMutationLeases)
    .values({
      ...key,
      acquiredAt: now,
      environmentId: args.environmentId,
      generation,
      requestId: args.requestId,
      threadId: args.threadId,
      updatedAt: now,
    })
    .run();
  appendEvent(tx, {
    ...key,
    createdAt: now,
    environmentId: args.environmentId,
    generation,
    requestId: args.requestId,
    threadId: args.threadId,
    type: "acquired",
  });
  return { ...key, generation, outcome: "acquired" };
}

export function acquireUnmanagedWorkspaceMutationLease(
  db: DbConnection,
  args: AcquireArgs,
): AcquireUnmanagedWorkspaceMutationLeaseResult {
  return db.transaction((tx) => acquireInTransaction(tx, args), {
    behavior: "immediate",
  });
}

/**
 * Makes workspace ownership and the durable running admission one atomic
 * state transition. Host dispatch is allowed only after this commits.
 */
export function acquireUnmanagedWorkspaceMutationLeaseAndStartAdmission(
  db: DbConnection,
  args: AcquireAndStartArgs,
): AcquireUnmanagedWorkspaceMutationLeaseAndStartResult {
  return db.transaction(
    (tx) => {
      if (getWorkAdmission(tx, args.requestId)?.status !== "waiting") {
        return { outcome: "admission-not-waiting" };
      }
      const workspace = acquireInTransaction(tx, args);
      if (workspace.outcome === "waiting") return workspace;
      if (
        !markWorkAdmissionRunning(tx, {
          id: args.requestId,
          reservationGeneration: args.reservationGeneration,
          reservationToken: args.reservationToken,
        })
      ) {
        throw new Error(
          `Work admission ${args.requestId} changed during atomic workspace acquisition`,
        );
      }
      return workspace;
    },
    { behavior: "immediate" },
  );
}

export function cancelUnmanagedWorkspaceMutationWaiter(
  db: DbConnection,
  args: { reason: string; requestId: string },
): boolean {
  return db.transaction(
    (tx) => {
      const waiter = tx
        .select()
        .from(unmanagedWorkspaceMutationWaiters)
        .where(
          and(
            eq(unmanagedWorkspaceMutationWaiters.requestId, args.requestId),
            eq(unmanagedWorkspaceMutationWaiters.state, "waiting"),
          ),
        )
        .get();
      if (!waiter) return false;
      tx.update(unmanagedWorkspaceMutationWaiters)
        .set({ reason: args.reason, state: "cancelled", updatedAt: Date.now() })
        .where(eq(unmanagedWorkspaceMutationWaiters.sequence, waiter.sequence))
        .run();
      appendEvent(tx, {
        canonicalPath: waiter.canonicalPath,
        createdAt: Date.now(),
        environmentId: waiter.environmentId,
        generation: null,
        hostId: waiter.hostId,
        reason: args.reason,
        requestId: waiter.requestId,
        threadId: waiter.threadId,
        type: "cancelled",
      });
      return true;
    },
    { behavior: "immediate" },
  );
}

export function releaseUnmanagedWorkspaceMutationLease(
  db: DbConnection,
  args: WorkspaceKey & {
    eventType?: "released" | "recovered";
    generation: number;
    reason: string;
  },
): ReleaseUnmanagedWorkspaceMutationLeaseResult {
  return db.transaction(
    (tx) => {
      const holder = getUnmanagedWorkspaceMutationLease(
        tx,
        args.hostId,
        args.canonicalPath,
      );
      if (!holder || holder.generation !== args.generation) {
        return { promoted: null, released: false };
      }
      tx.delete(unmanagedWorkspaceMutationLeases)
        .where(
          and(
            eq(unmanagedWorkspaceMutationLeases.hostId, args.hostId),
            eq(
              unmanagedWorkspaceMutationLeases.canonicalPath,
              args.canonicalPath,
            ),
            eq(unmanagedWorkspaceMutationLeases.generation, args.generation),
          ),
        )
        .run();
      appendEvent(tx, {
        canonicalPath: holder.canonicalPath,
        createdAt: Date.now(),
        environmentId: holder.environmentId,
        generation: holder.generation,
        hostId: holder.hostId,
        reason: args.reason,
        requestId: holder.requestId,
        threadId: holder.threadId,
        type: args.eventType ?? "released",
      });
      const waiter = tx
        .select()
        .from(unmanagedWorkspaceMutationWaiters)
        .where(
          and(
            eq(unmanagedWorkspaceMutationWaiters.hostId, args.hostId),
            eq(
              unmanagedWorkspaceMutationWaiters.canonicalPath,
              args.canonicalPath,
            ),
            eq(unmanagedWorkspaceMutationWaiters.state, "waiting"),
          ),
        )
        .orderBy(asc(unmanagedWorkspaceMutationWaiters.sequence))
        .limit(1)
        .get();
      if (!waiter) return { promoted: null, released: true };
      const generation = nextGeneration(tx, args);
      const now = Date.now();
      const promoted = tx
        .insert(unmanagedWorkspaceMutationLeases)
        .values({
          canonicalPath: waiter.canonicalPath,
          acquiredAt: now,
          environmentId: waiter.environmentId,
          generation,
          hostId: waiter.hostId,
          requestId: waiter.requestId,
          threadId: waiter.threadId,
          updatedAt: now,
        })
        .returning()
        .get();
      tx.update(unmanagedWorkspaceMutationWaiters)
        .set({
          promotedGeneration: generation,
          state: "promoted",
          updatedAt: now,
        })
        .where(eq(unmanagedWorkspaceMutationWaiters.sequence, waiter.sequence))
        .run();
      appendEvent(tx, {
        canonicalPath: waiter.canonicalPath,
        createdAt: now,
        environmentId: waiter.environmentId,
        generation,
        hostId: waiter.hostId,
        requestId: waiter.requestId,
        threadId: waiter.threadId,
        type: "promoted",
      });
      return { promoted, released: true };
    },
    { behavior: "immediate" },
  );
}

export function listUnmanagedWorkspaceMutationLeaseEvents(
  db: DbQueryConnection,
  args: WorkspaceKey,
): UnmanagedWorkspaceMutationLeaseEventRow[] {
  return db
    .select()
    .from(unmanagedWorkspaceMutationLeaseEvents)
    .where(
      and(
        eq(unmanagedWorkspaceMutationLeaseEvents.hostId, args.hostId),
        eq(
          unmanagedWorkspaceMutationLeaseEvents.canonicalPath,
          args.canonicalPath,
        ),
      ),
    )
    .orderBy(asc(unmanagedWorkspaceMutationLeaseEvents.id))
    .all();
}
