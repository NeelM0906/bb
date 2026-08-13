import {
  acquireUnmanagedWorkspaceMutationLease,
  acquireUnmanagedWorkspaceMutationLeaseAndStartAdmission,
  cancelUnmanagedWorkspaceMutationWaiter,
  createWorkAdmission,
  getEnvironment,
  getCurrentThreadWorkAdmission,
  getFirstHostEligibleWaitingAdmission,
  hasProtectedUnmanagedWorkspaceOnHost,
  getThread,
  getUnmanagedWorkspaceMutationLeaseForThread,
  getUnmanagedWorkspaceMutationWaitState,
  isPromotedUnmanagedWorkspaceMutationLease,
  getWorkAdmission,
  listCurrentWorkAdmissions,
  listUncanonicalizedLiveUnmanagedEnvironmentsOnHost,
  listUnmanagedWorkspaceMutationLeases,
  listWaitingWorkAdmissions,
  markWaitingWorkAdmissionTerminal,
  markWorkAdmissionTerminal,
  recordEnvironmentCanonicalPath,
  releaseUnmanagedWorkspaceMutationLease,
  releaseUnmanagedWorkspaceMutationLeaseInTransaction,
  updateWorkAdmissionWaitingReason,
  type WorkAdmissionRow,
  type DbTransaction,
} from "@bb/db";
import {
  hostDaemonCommandSchema,
  type HostAdmissionReason,
  type HostAdmissionReservation,
  type HostAdmissionReserveResult,
  type HostDaemonCommand,
} from "@bb/host-daemon-contract";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";

const ADMISSION_RPC_TIMEOUT_MS = 10_000;
const INITIAL_WAITING_REASON = "Awaiting host capacity";

type ProviderWorkCommand = Extract<
  HostDaemonCommand,
  { type: "thread.start" | "turn.submit" }
>;

type WorkAdmissionDeps = LoggedWorkSessionDeps;

const promotionWaitersByHost = new Map<string, Set<() => void>>();
const workspacePromotionWaiters = new Map<string, Set<() => void>>();
const canonicalizationByDatabase = new WeakMap<
  WorkAdmissionDeps["db"],
  Map<string, Promise<void>>
>();

function workspacePromotionKey(hostId: string, canonicalPath: string): string {
  return `${hostId}\0${canonicalPath}`;
}

function waitForWorkspacePromotion(
  deps: Pick<WorkAdmissionDeps, "db">,
  args: { canonicalPath: string; hostId: string; requestId: string },
): Promise<void> {
  const key = workspacePromotionKey(args.hostId, args.canonicalPath);
  return new Promise((resolve) => {
    const waiters = workspacePromotionWaiters.get(key) ?? new Set();
    const waiter = () => {
      waiters.delete(waiter);
      if (waiters.size === 0) workspacePromotionWaiters.delete(key);
      resolve();
    };
    waiters.add(waiter);
    workspacePromotionWaiters.set(key, waiters);
    // Promotion can happen after the acquisition transaction commits but
    // before this process registers its in-memory waiter. Re-read durable
    // state after registration so that race cannot strand the request.
    if (
      getUnmanagedWorkspaceMutationWaitState(deps.db, args.requestId) === null
    ) {
      waiter();
    }
  });
}

function signalWorkspacePromotion(hostId: string, canonicalPath: string): void {
  const key = workspacePromotionKey(hostId, canonicalPath);
  const waiters = workspacePromotionWaiters.get(key);
  if (!waiters) return;
  for (const waiter of [...waiters]) waiter();
}

export function isProviderWorkCommand(
  command: HostDaemonCommand,
): command is ProviderWorkCommand {
  return command.type === "thread.start" || command.type === "turn.submit";
}

function createHostPromotionWaiter(hostId: string): {
  cancel: () => void;
  promise: Promise<void>;
} {
  let cancel = () => {};
  const promise = new Promise<void>((resolve) => {
    const waiters = promotionWaitersByHost.get(hostId) ?? new Set();
    let active = true;
    const waiter = () => {
      if (!active) return;
      active = false;
      waiters.delete(waiter);
      if (waiters.size === 0) promotionWaitersByHost.delete(hostId);
      resolve();
    };
    cancel = () => {
      if (!active) return;
      active = false;
      waiters.delete(waiter);
      if (waiters.size === 0) promotionWaitersByHost.delete(hostId);
    };
    waiters.add(waiter);
    promotionWaitersByHost.set(hostId, waiters);
  });
  return { cancel, promise };
}

export function signalHostAdmissionPromotion(hostId: string): void {
  const waiters = promotionWaitersByHost.get(hostId);
  if (!waiters) return;
  for (const waiter of [...waiters]) waiter();
}

async function canonicalizeLegacyUnmanagedWorkspacePaths(
  deps: WorkAdmissionDeps,
  args: { hostId: string; targetEnvironmentId: string },
): Promise<void> {
  const environments = listUncanonicalizedLiveUnmanagedEnvironmentsOnHost(
    deps.db,
    args.hostId,
  );
  if (environments.length === 0) return;

  const canonicalize = async (environment: (typeof environments)[number]) => {
    if (environment.path === null) return;
    const result = await callHostRetryableOnlineRpc(deps, {
      command: { type: "project.inspect", path: environment.path },
      hostId: args.hostId,
      timeoutMs: ADMISSION_RPC_TIMEOUT_MS,
    });
    recordEnvironmentCanonicalPath(
      deps.db,
      deps.hub,
      environment.id,
      result.path,
    );
  };

  // Fail closed across every not-yet-confirmed unmanaged environment on an
  // opted-in host: any one may be a legacy alias of the target workspace.
  // Persist each confirmation and scan sequentially so a host with many
  // historical environments pays this cost once without a subprocess burst.
  const target = environments.find(
    (environment) => environment.id === args.targetEnvironmentId,
  );
  if (target) await canonicalize(target);
  for (const environment of environments) {
    if (environment.id !== target?.id) await canonicalize(environment);
  }
}

async function ensureLegacyUnmanagedWorkspacePathsCanonical(
  deps: WorkAdmissionDeps,
  args: { hostId: string; targetEnvironmentId: string },
): Promise<void> {
  const target = getEnvironment(deps.db, args.targetEnvironmentId);
  if (
    !target ||
    target.hostId !== args.hostId ||
    target.path === null ||
    target.workspaceProvisionType !== "unmanaged" ||
    target.status === "destroyed"
  ) {
    return;
  }
  if (!hasProtectedUnmanagedWorkspaceOnHost(deps.db, args.hostId)) return;
  let byHost = canonicalizationByDatabase.get(deps.db);
  if (!byHost) {
    byHost = new Map();
    canonicalizationByDatabase.set(deps.db, byHost);
  }
  for (;;) {
    let pending = byHost.get(args.hostId);
    if (!pending) {
      pending = canonicalizeLegacyUnmanagedWorkspacePaths(deps, args);
      byHost.set(args.hostId, pending);
    }
    try {
      await pending;
    } finally {
      if (byHost.get(args.hostId) === pending) byHost.delete(args.hostId);
    }
    if (
      listUncanonicalizedLiveUnmanagedEnvironmentsOnHost(deps.db, args.hostId)
        .length === 0
    ) {
      return;
    }
  }
}

function resolveAdmissionReason(
  deps: Pick<WorkAdmissionDeps, "db">,
  args: {
    explicitReason?: HostAdmissionReason;
    threadId: string;
  },
): HostAdmissionReason {
  if (args.explicitReason !== undefined) return args.explicitReason;
  const current = getCurrentThreadWorkAdmission(deps.db, args.threadId);
  if (current) return current.reason;
  const thread = getThread(deps.db, args.threadId);
  if (thread?.parentThreadId !== null && thread?.parentThreadId !== undefined) {
    return "child";
  }
  if (thread?.originPluginId !== null && thread?.originPluginId !== undefined) {
    return "automation";
  }
  return "interactive";
}

function ensureAdmissionRow(
  deps: Pick<WorkAdmissionDeps, "db">,
  args: {
    command: ProviderWorkCommand;
    hostId: string;
    reason: HostAdmissionReason;
  },
): WorkAdmissionRow {
  const current = getCurrentThreadWorkAdmission(deps.db, args.command.threadId);
  if (current) return current;
  return createWorkAdmission(deps.db, {
    commandJson: JSON.stringify(args.command),
    hostId: args.hostId,
    id: args.command.requestId,
    reason: args.reason,
    threadId: args.command.threadId,
    waitingReason: INITIAL_WAITING_REASON,
  });
}

async function reserve(
  deps: WorkAdmissionDeps,
  args: {
    command: ProviderWorkCommand;
    hostId: string;
    reason: HostAdmissionReason;
  },
): Promise<HostAdmissionReserveResult> {
  return callHostRetryableOnlineRpc(deps, {
    command: {
      type: "host.admission.reserve",
      hostId: args.hostId,
      requestId: args.command.requestId,
      threadId: args.command.threadId,
      reason: args.reason,
    },
    hostId: args.hostId,
    timeoutMs: ADMISSION_RPC_TIMEOUT_MS,
  });
}

async function releaseHostReservation(
  deps: WorkAdmissionDeps,
  reservation: HostAdmissionReservation,
): Promise<boolean> {
  const result = await callHostRetryableOnlineRpc(deps, {
    command: { type: "host.admission.release", reservation },
    hostId: reservation.hostId,
    timeoutMs: ADMISSION_RPC_TIMEOUT_MS,
  });
  return result.released;
}

function workspaceWaitingReason(args: {
  canonicalPath: string;
  holderThreadId: string;
}): string {
  return `Another run (${args.holderThreadId}) owns unmanaged workspace ${args.canonicalPath}`;
}

function releaseWorkspaceLeaseForThread(
  deps: Pick<WorkAdmissionDeps, "db">,
  args: {
    eventType?: "released" | "recovered";
    reason: string;
    threadId: string;
  },
): boolean {
  const lease = getUnmanagedWorkspaceMutationLeaseForThread(
    deps.db,
    args.threadId,
  );
  if (!lease) return false;
  const result = releaseUnmanagedWorkspaceMutationLease(deps.db, {
    canonicalPath: lease.canonicalPath,
    ...(args.eventType === undefined ? {} : { eventType: args.eventType }),
    generation: lease.generation,
    hostId: lease.hostId,
    reason: args.reason,
  });
  if (result.released) {
    signalWorkspacePromotion(lease.hostId, lease.canonicalPath);
  }
  return result.released;
}

export function releaseWorkspaceLeaseForThreadInTransaction(
  deps: { db: DbTransaction },
  args: { reason: string; threadId: string },
): boolean {
  const lease = getUnmanagedWorkspaceMutationLeaseForThread(
    deps.db,
    args.threadId,
  );
  if (!lease) return false;
  const result = releaseUnmanagedWorkspaceMutationLeaseInTransaction(deps.db, {
    canonicalPath: lease.canonicalPath,
    generation: lease.generation,
    hostId: lease.hostId,
    reason: args.reason,
  });
  if (result.released) {
    signalWorkspacePromotion(lease.hostId, lease.canonicalPath);
  }
  return result.released;
}

export async function awaitThreadWorkAdmission(
  deps: WorkAdmissionDeps,
  args: {
    command: ProviderWorkCommand;
    hostId: string;
    reason?: HostAdmissionReason;
  },
): Promise<HostAdmissionReservation> {
  const reason = resolveAdmissionReason(deps, {
    ...(args.reason === undefined ? {} : { explicitReason: args.reason }),
    threadId: args.command.threadId,
  });
  // Persist before the first awaited host operation. If the server exits while
  // canonicalization is in flight, reconnect recovery can still resume this
  // command from the durable admission queue.
  let row = ensureAdmissionRow(deps, { ...args, reason });
  try {
    await ensureLegacyUnmanagedWorkspacePathsCanonical(deps, {
      hostId: args.hostId,
      targetEnvironmentId: args.command.environmentId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await releaseThreadWorkAdmission(deps, {
      terminalReason: `Workspace canonicalization failed: ${message}`,
      threadId: row.threadId,
    });
    throw error;
  }

  for (;;) {
    if (row.status === "terminal") {
      throw new Error(`Work admission ${row.id} is already terminal`);
    }
    if (row.status === "running") {
      const result = await reserve(deps, { ...args, reason });
      if (result.outcome === "reserved") {
        const workspace = acquireUnmanagedWorkspaceMutationLease(deps.db, {
          environmentId: args.command.environmentId,
          requestId: row.id,
          threadId: args.command.threadId,
        });
        if (workspace.outcome !== "waiting") return result.reservation;
        await releaseHostReservation(deps, result.reservation);
        throw new Error(
          `Running admission ${row.id} lost workspace ownership to ${workspace.holder.threadId}`,
        );
      }
      throw new Error(
        `Host lost running admission ${row.id} for thread ${row.threadId}`,
      );
    }

    // Subscribe before checking queue position or reserving. A release can
    // otherwise land during the reserve RPC and be lost before we start
    // waiting, stranding runnable work until some unrelated later release.
    const promotion = createHostPromotionWaiter(args.hostId);
    try {
      const head = getFirstHostEligibleWaitingAdmission(deps.db, args.hostId);
      if (head?.id !== row.id) {
        await promotion.promise;
        row = getWorkAdmission(deps.db, row.id) ?? row;
        continue;
      }

      const result = await reserve(deps, { ...args, reason });
      if (result.outcome === "unavailable") {
        updateWorkAdmissionWaitingReason(deps.db, {
          id: row.id,
          waitingReason: result.reason,
        });
        await promotion.promise;
        row = getWorkAdmission(deps.db, row.id) ?? row;
        continue;
      }
      const workspace = acquireUnmanagedWorkspaceMutationLeaseAndStartAdmission(
        deps.db,
        {
          environmentId: args.command.environmentId,
          requestId: row.id,
          reservationGeneration: result.reservation.generation,
          reservationToken: result.reservation.token,
          threadId: args.command.threadId,
        },
      );
      if (workspace.outcome === "waiting") {
        await releaseHostReservation(deps, result.reservation);
        updateWorkAdmissionWaitingReason(deps.db, {
          id: row.id,
          waitingReason: workspaceWaitingReason({
            canonicalPath: workspace.canonicalPath,
            holderThreadId: workspace.holder.threadId,
          }),
        });
        // The row was the durable FIFO head while another admission may have
        // subscribed and gone to sleep. It is no longer host-eligible once the
        // workspace waiter exists, so wake peers to re-evaluate the queue.
        signalHostAdmissionPromotion(args.hostId);
        await waitForWorkspacePromotion(deps, {
          canonicalPath: workspace.canonicalPath,
          hostId: workspace.hostId,
          requestId: row.id,
        });
        row = getWorkAdmission(deps.db, row.id) ?? row;
        continue;
      }
      if (workspace.outcome !== "admission-not-waiting") {
        signalHostAdmissionPromotion(args.hostId);
        return result.reservation;
      }
      await releaseHostReservation(deps, result.reservation);
      row = getWorkAdmission(deps.db, row.id) ?? row;
    } finally {
      promotion.cancel();
    }
  }
}

export async function releaseThreadWorkAdmission(
  deps: WorkAdmissionDeps,
  args: { terminalReason: string; threadId: string },
): Promise<boolean> {
  const row = getCurrentThreadWorkAdmission(deps.db, args.threadId);
  if (!row) return false;
  if (
    row.status === "waiting" ||
    row.reservationGeneration === null ||
    row.reservationToken === null
  ) {
    const settled = markWaitingWorkAdmissionTerminal(deps.db, {
      id: row.id,
      terminalReason: args.terminalReason,
    });
    if (settled) {
      const workspaceWait = getUnmanagedWorkspaceMutationWaitState(
        deps.db,
        row.id,
      );
      cancelUnmanagedWorkspaceMutationWaiter(deps.db, {
        reason: args.terminalReason,
        requestId: row.id,
      });
      if (workspaceWait) {
        signalWorkspacePromotion(row.hostId, workspaceWait.canonicalPath);
      }
      releaseWorkspaceLeaseForThread(deps, {
        reason: args.terminalReason,
        threadId: row.threadId,
      });
      signalHostAdmissionPromotion(row.hostId);
    }
    return settled;
  }

  const reservation: HostAdmissionReservation = {
    generation: row.reservationGeneration,
    hostId: row.hostId,
    reason: row.reason,
    token: row.reservationToken,
  };
  if (!(await releaseHostReservation(deps, reservation))) return false;
  const settled = markWorkAdmissionTerminal(deps.db, {
    id: row.id,
    reservationGeneration: row.reservationGeneration,
    terminalReason: args.terminalReason,
  });
  if (settled) {
    releaseWorkspaceLeaseForThread(deps, {
      reason: args.terminalReason,
      threadId: row.threadId,
    });
    signalHostAdmissionPromotion(row.hostId);
  }
  return settled;
}

export function listRecoverableWorkAdmissionCommands(
  deps: Pick<WorkAdmissionDeps, "db" | "logger">,
  args: { hostId?: string } = {},
): Array<{
  command: ProviderWorkCommand;
  hostId: string;
  reason: HostAdmissionReason;
}> {
  return listWaitingWorkAdmissions(deps.db, args).flatMap((row) => {
    let stored: unknown;
    try {
      stored = JSON.parse(row.commandJson);
    } catch {
      stored = null;
    }
    const parsed = hostDaemonCommandSchema.safeParse(stored);
    if (!parsed.success || !isProviderWorkCommand(parsed.data)) {
      const workspaceWait = getUnmanagedWorkspaceMutationWaitState(
        deps.db,
        row.id,
      );
      const settled = markWaitingWorkAdmissionTerminal(deps.db, {
        id: row.id,
        terminalReason: "Stored admission command failed validation",
      });
      if (settled) {
        cancelUnmanagedWorkspaceMutationWaiter(deps.db, {
          reason: "Stored admission command failed validation",
          requestId: row.id,
        });
        if (workspaceWait) {
          signalWorkspacePromotion(row.hostId, workspaceWait.canonicalPath);
        }
        releaseWorkspaceLeaseForThread(deps, {
          reason: "Stored admission command failed validation",
          threadId: row.threadId,
        });
        signalHostAdmissionPromotion(row.hostId);
      }
      deps.logger.error(
        { admissionId: row.id, threadId: row.threadId },
        "Stored work admission command is invalid",
      );
      return [];
    }
    return [{ command: parsed.data, hostId: row.hostId, reason: row.reason }];
  });
}

export async function reconcileHostWorkAdmissions(
  deps: WorkAdmissionDeps,
  args: { hostId: string },
): Promise<void> {
  const result = await callHostRetryableOnlineRpc(deps, {
    command: { type: "host.admission.reconcile" },
    hostId: args.hostId,
    timeoutMs: ADMISSION_RPC_TIMEOUT_MS,
  });
  const hostReservationsByToken = new Map(
    result.reservations.map((entry) => [entry.reservation.token, entry]),
  );
  const local = listCurrentWorkAdmissions(deps.db, { hostId: args.hostId });
  const localTokens = new Set(
    local.flatMap((row) =>
      row.reservationToken === null ? [] : [row.reservationToken],
    ),
  );

  for (const row of local) {
    if (row.status !== "running") continue;
    const remote =
      row.reservationToken === null
        ? undefined
        : hostReservationsByToken.get(row.reservationToken);
    if (
      remote &&
      remote.threadId === row.threadId &&
      remote.reservation.generation === row.reservationGeneration
    ) {
      const thread = getThread(deps.db, row.threadId);
      if (thread?.status === "active" || thread?.status === "stopping") {
        continue;
      }
      await releaseThreadWorkAdmission(deps, {
        terminalReason: `recovered settled ${thread?.status ?? "deleted"} thread`,
        threadId: row.threadId,
      });
      continue;
    }
    if (row.reservationGeneration !== null) {
      const recovered = markWorkAdmissionTerminal(deps.db, {
        id: row.id,
        reservationGeneration: row.reservationGeneration,
        terminalReason: "Host reservation missing during recovery",
      });
      if (recovered) {
        releaseWorkspaceLeaseForThread(deps, {
          eventType: "recovered",
          reason: "Host reservation missing during recovery",
          threadId: row.threadId,
        });
      }
      signalHostAdmissionPromotion(row.hostId);
    }
  }

  for (const lease of listUnmanagedWorkspaceMutationLeases(deps.db, {
    hostId: args.hostId,
  })) {
    const admission = getWorkAdmission(deps.db, lease.requestId);
    if (admission?.status === "running") continue;
    if (
      admission?.status === "waiting" &&
      isPromotedUnmanagedWorkspaceMutationLease(deps.db, lease)
    ) {
      continue;
    }
    releaseWorkspaceLeaseForThread(deps, {
      eventType: "recovered",
      reason: "Workspace holder had no running work admission during recovery",
      threadId: lease.threadId,
    });
  }

  for (const remote of result.reservations) {
    if (localTokens.has(remote.reservation.token)) continue;
    await callHostRetryableOnlineRpc(deps, {
      command: {
        type: "host.admission.release",
        reservation: remote.reservation,
      },
      hostId: args.hostId,
      timeoutMs: ADMISSION_RPC_TIMEOUT_MS,
    });
  }
}
