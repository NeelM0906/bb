import { and, asc, desc, eq, inArray, notExists } from "drizzle-orm";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import {
  unmanagedWorkspaceMutationWaiters,
  workAdmissions,
  type WorkAdmissionReason,
} from "../schema.js";

export type WorkAdmissionRow = typeof workAdmissions.$inferSelect;

export interface CreateWorkAdmissionInput {
  commandJson: string;
  createdAt?: number;
  hostId: string;
  id: string;
  reason: WorkAdmissionReason;
  threadId: string;
  waitingReason: string;
}

export interface ListWaitingWorkAdmissionsArgs {
  hostId?: string;
}

export type ListCurrentWorkAdmissionsArgs = ListWaitingWorkAdmissionsArgs;

export interface MarkWorkAdmissionRunningArgs {
  id: string;
  reservationGeneration: number;
  reservationToken: string;
}

export interface MarkWorkAdmissionTerminalArgs {
  id: string;
  reservationGeneration: number;
  terminalReason: string;
}

export interface MarkWaitingWorkAdmissionTerminalArgs {
  id: string;
  terminalReason: string;
}

export interface UpdateWorkAdmissionWaitingReasonArgs {
  id: string;
  waitingReason: string;
}

export interface UpdateCurrentWorkAdmissionCommandArgs {
  commandJson: string;
  id: string;
}

export function createWorkAdmission(
  db: DbConnection,
  input: CreateWorkAdmissionInput,
): WorkAdmissionRow {
  const now = input.createdAt ?? Date.now();
  db.insert(workAdmissions)
    .values({
      commandJson: input.commandJson,
      createdAt: now,
      hostId: input.hostId,
      id: input.id,
      reason: input.reason,
      status: "waiting",
      threadId: input.threadId,
      updatedAt: now,
      waitingReason: input.waitingReason,
    })
    .onConflictDoNothing({ target: workAdmissions.id })
    .run();
  const row = getWorkAdmission(db, input.id);
  if (!row) {
    throw new Error(`Failed to create work admission ${input.id}`);
  }
  return row;
}

export function getWorkAdmission(
  db: DbQueryConnection,
  id: string,
): WorkAdmissionRow | null {
  return (
    db.select().from(workAdmissions).where(eq(workAdmissions.id, id)).get() ??
    null
  );
}

export function getCurrentThreadWorkAdmission(
  db: DbQueryConnection,
  threadId: string,
): WorkAdmissionRow | null {
  return (
    db
      .select()
      .from(workAdmissions)
      .where(
        and(
          eq(workAdmissions.threadId, threadId),
          inArray(workAdmissions.status, ["waiting", "running"]),
        ),
      )
      .orderBy(desc(workAdmissions.createdAt), desc(workAdmissions.id))
      .limit(1)
      .get() ?? null
  );
}

export function listWaitingWorkAdmissions(
  db: DbQueryConnection,
  args: ListWaitingWorkAdmissionsArgs = {},
): WorkAdmissionRow[] {
  return db
    .select()
    .from(workAdmissions)
    .where(
      and(
        eq(workAdmissions.status, "waiting"),
        args.hostId === undefined
          ? undefined
          : eq(workAdmissions.hostId, args.hostId),
      ),
    )
    .orderBy(asc(workAdmissions.createdAt), asc(workAdmissions.id))
    .all();
}

export function getFirstHostEligibleWaitingAdmission(
  db: DbQueryConnection,
  hostId: string,
): WorkAdmissionRow | null {
  const workspaceWait = db
    .select({ requestId: unmanagedWorkspaceMutationWaiters.requestId })
    .from(unmanagedWorkspaceMutationWaiters)
    .where(
      and(
        eq(unmanagedWorkspaceMutationWaiters.requestId, workAdmissions.id),
        eq(unmanagedWorkspaceMutationWaiters.state, "waiting"),
      ),
    );
  return (
    db
      .select()
      .from(workAdmissions)
      .where(
        and(
          eq(workAdmissions.status, "waiting"),
          eq(workAdmissions.hostId, hostId),
          notExists(workspaceWait),
        ),
      )
      .orderBy(asc(workAdmissions.createdAt), asc(workAdmissions.id))
      .limit(1)
      .get() ?? null
  );
}

export function listCurrentWorkAdmissions(
  db: DbQueryConnection,
  args: ListCurrentWorkAdmissionsArgs = {},
): WorkAdmissionRow[] {
  return db
    .select()
    .from(workAdmissions)
    .where(
      and(
        inArray(workAdmissions.status, ["waiting", "running"]),
        args.hostId === undefined
          ? undefined
          : eq(workAdmissions.hostId, args.hostId),
      ),
    )
    .orderBy(asc(workAdmissions.createdAt), asc(workAdmissions.id))
    .all();
}

export function markWorkAdmissionRunning(
  db: DbConnection | DbTransaction,
  args: MarkWorkAdmissionRunningArgs,
): boolean {
  return (
    db
      .update(workAdmissions)
      .set({
        reservationGeneration: args.reservationGeneration,
        reservationToken: args.reservationToken,
        status: "running",
        updatedAt: Date.now(),
        waitingReason: null,
      })
      .where(
        and(
          eq(workAdmissions.id, args.id),
          eq(workAdmissions.status, "waiting"),
        ),
      )
      .run().changes === 1
  );
}

export function markWorkAdmissionTerminal(
  db: DbConnection,
  args: MarkWorkAdmissionTerminalArgs,
): boolean {
  return (
    db
      .update(workAdmissions)
      .set({
        status: "terminal",
        terminalReason: args.terminalReason,
        updatedAt: Date.now(),
        waitingReason: null,
      })
      .where(
        and(
          eq(workAdmissions.id, args.id),
          eq(workAdmissions.status, "running"),
          eq(
            workAdmissions.reservationGeneration,
            args.reservationGeneration,
          ),
        ),
      )
      .run().changes === 1
  );
}

export function markWaitingWorkAdmissionTerminal(
  db: DbConnection,
  args: MarkWaitingWorkAdmissionTerminalArgs,
): boolean {
  return (
    db
      .update(workAdmissions)
      .set({
        status: "terminal",
        terminalReason: args.terminalReason,
        updatedAt: Date.now(),
        waitingReason: null,
      })
      .where(
        and(
          eq(workAdmissions.id, args.id),
          eq(workAdmissions.status, "waiting"),
        ),
      )
      .run().changes === 1
  );
}

export function updateWorkAdmissionWaitingReason(
  db: DbConnection,
  args: UpdateWorkAdmissionWaitingReasonArgs,
): boolean {
  return (
    db
      .update(workAdmissions)
      .set({ waitingReason: args.waitingReason, updatedAt: Date.now() })
      .where(
        and(
          eq(workAdmissions.id, args.id),
          eq(workAdmissions.status, "waiting"),
        ),
      )
      .run().changes === 1
  );
}

export function updateCurrentWorkAdmissionCommand(
  db: DbConnection,
  args: UpdateCurrentWorkAdmissionCommandArgs,
): boolean {
  return (
    db
      .update(workAdmissions)
      .set({ commandJson: args.commandJson, updatedAt: Date.now() })
      .where(
        and(
          eq(workAdmissions.id, args.id),
          inArray(workAdmissions.status, ["waiting", "running"]),
        ),
      )
      .run().changes === 1
  );
}
