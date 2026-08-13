import { randomUUID } from "node:crypto";
import {
  type HostAdmissionReason,
  type HostDaemonCommand,
  type HostDaemonCommandResult,
  type HostDaemonSettledCommandType,
} from "@bb/host-daemon-contract";
import { getThread } from "@bb/db";
import { ApiError } from "../../errors.js";
import {
  buildCommandResultSettlementDeps,
  type CommandResultPostCommitAction,
  type CommandResultSideEffectsDeps,
  type HostDaemonCommandExecutionRecord,
  type HostDaemonCommandForType,
  type LiveHostCommandFailureResultReportForType,
  type LiveHostCommandSuccessResultReportForType,
} from "../../internal/command-result-side-effects.js";
import { handleLiveCommandResultSideEffects } from "../../internal/command-results.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { callHostOnlineRpc } from "./online-rpc.js";
import {
  awaitThreadWorkAdmission,
  isProviderWorkCommand,
  listRecoverableWorkAdmissionCommands,
  releaseThreadWorkAdmission,
} from "../threads/work-admission.js";

export const LIVE_DAEMON_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface RunLiveHostCommandArgs<
  TType extends HostDaemonSettledCommandType,
> {
  command: Extract<HostDaemonCommand, { type: TType }>;
  admissionReason?: HostAdmissionReason;
  execution?: HostDaemonCommandExecutionRecord;
  hostId: string;
  timeoutMs: number;
}

interface LiveHostCommandErrorHandlerArgs<
  TType extends HostDaemonSettledCommandType,
> {
  command: Extract<HostDaemonCommand, { type: TType }>;
  error: Error;
  execution: HostDaemonCommandExecutionRecord;
  hostId: string;
}

type LiveHostCommandErrorHandler<TType extends HostDaemonSettledCommandType> = (
  args: LiveHostCommandErrorHandlerArgs<TType>,
) => void;

export interface StartLiveHostCommandArgs<
  TType extends HostDaemonSettledCommandType,
> extends RunLiveHostCommandArgs<TType> {
  onError?: LiveHostCommandErrorHandler<TType>;
  onExpectedError?: LiveHostCommandErrorHandler<TType>;
  onSettled?: () => void | Promise<void>;
}

type LiveHostCommandResultReportForType<
  TType extends HostDaemonSettledCommandType,
> =
  | LiveHostCommandSuccessResultReportForType<TType>
  | LiveHostCommandFailureResultReportForType<TType>;

interface ApplyLiveHostCommandReportArgs<
  TType extends HostDaemonSettledCommandType,
> {
  command: HostDaemonCommandForType<TType>;
  execution: HostDaemonCommandExecutionRecord;
  report: LiveHostCommandResultReportForType<TType>;
}

interface BuildLiveHostCommandSuccessReportArgs<
  TType extends HostDaemonSettledCommandType,
> {
  command: HostDaemonCommandForType<TType>;
  completedAt: number;
  execution: HostDaemonCommandExecutionRecord;
  result: HostDaemonCommandResult<TType>;
}

interface BuildLiveHostCommandFailureReportArgs<
  TType extends HostDaemonSettledCommandType,
> {
  command: HostDaemonCommandForType<TType>;
  completedAt: number;
  error: Error;
  execution: HostDaemonCommandExecutionRecord;
}

export interface ExpectedLiveHostCommandErrorLogFields {
  errorCode: string;
  errorMessage: string;
  errorStatus: number;
}

interface LiveHostCommandBaseLogFields {
  commandType: HostDaemonSettledCommandType;
  environmentId?: string;
  executionId: string;
  hostId: string;
  threadId?: string;
}

const EXPECTED_LIVE_HOST_COMMAND_ERROR_CODES = new Set(["provision_cancelled"]);
const activeWorkAdmissionTasksByDatabase = new WeakMap<
  CommandResultSideEffectsDeps["db"],
  Map<string, number>
>();

function registerActiveWorkAdmissionTask(
  deps: Pick<CommandResultSideEffectsDeps, "db">,
  requestId: string,
): () => void {
  let active = activeWorkAdmissionTasksByDatabase.get(deps.db);
  if (!active) {
    active = new Map();
    activeWorkAdmissionTasksByDatabase.set(deps.db, active);
  }
  active.set(requestId, (active.get(requestId) ?? 0) + 1);
  return () => {
    const count = active.get(requestId) ?? 0;
    if (count <= 1) active.delete(requestId);
    else active.set(requestId, count - 1);
    if (active.size === 0) activeWorkAdmissionTasksByDatabase.delete(deps.db);
  };
}

function hasActiveWorkAdmissionTask(
  deps: Pick<CommandResultSideEffectsDeps, "db">,
  requestId: string,
): boolean {
  return (
    (activeWorkAdmissionTasksByDatabase.get(deps.db)?.get(requestId) ?? 0) > 0
  );
}

function commandFailureCode(error: Error): string {
  if (error instanceof ApiError) {
    return error.body.code;
  }
  return "live_command_failed";
}

function liveHostCommandBaseLogFields<
  TType extends HostDaemonSettledCommandType,
>(args: LiveHostCommandErrorHandlerArgs<TType>): LiveHostCommandBaseLogFields {
  return {
    commandType: args.command.type,
    ...("environmentId" in args.command
      ? { environmentId: args.command.environmentId }
      : {}),
    executionId: args.execution.id,
    hostId: args.hostId,
    ...("threadId" in args.command ? { threadId: args.command.threadId } : {}),
  };
}

export function expectedLiveHostCommandErrorLogFields(
  error: Error,
): ExpectedLiveHostCommandErrorLogFields | null {
  if (
    !(error instanceof ApiError) ||
    !EXPECTED_LIVE_HOST_COMMAND_ERROR_CODES.has(error.body.code)
  ) {
    return null;
  }
  return {
    errorCode: error.body.code,
    errorMessage: error.body.message,
    errorStatus: error.status,
  };
}

function buildLiveHostCommandFailureReport<
  TType extends HostDaemonSettledCommandType,
>(
  args: BuildLiveHostCommandFailureReportArgs<TType>,
): LiveHostCommandFailureResultReportForType<TType> {
  return {
    executionId: args.execution.id,
    type: args.command.type,
    completedAt: args.completedAt,
    ok: false,
    errorCode: commandFailureCode(args.error),
    errorMessage: args.error.message,
  };
}

function buildLiveHostCommandSuccessReport<
  TType extends HostDaemonSettledCommandType,
>(
  args: BuildLiveHostCommandSuccessReportArgs<TType>,
): LiveHostCommandSuccessResultReportForType<TType> {
  return {
    executionId: args.execution.id,
    type: args.command.type,
    completedAt: args.completedAt,
    ok: true,
    result: args.result,
  };
}

async function runPostCommitActions(
  deps: CommandResultSideEffectsDeps,
  actions: readonly CommandResultPostCommitAction[],
): Promise<void> {
  for (const action of actions) {
    await action.run(deps);
  }
}

async function applyLiveHostCommandReport<
  TType extends HostDaemonSettledCommandType,
>(
  deps: CommandResultSideEffectsDeps,
  args: ApplyLiveHostCommandReportArgs<TType>,
): Promise<void> {
  const notificationBuffer = new NotificationBuffer();
  const sideEffects = deps.db.transaction(
    (tx) =>
      handleLiveCommandResultSideEffects(
        buildCommandResultSettlementDeps({
          db: tx,
          deps,
          hub: notificationBuffer,
        }),
        args,
      ),
    { behavior: "immediate" },
  );
  notificationBuffer.flushInto(deps.hub);
  await runPostCommitActions(deps, sideEffects.postCommitActions);
}

export function createLiveHostCommandExecution(
  hostId: string,
): HostDaemonCommandExecutionRecord {
  return {
    createdAt: Date.now(),
    hostId,
    id: `rpc_${randomUUID()}`,
  };
}

export async function runLiveHostCommand<
  TType extends HostDaemonSettledCommandType,
>(
  deps: CommandResultSideEffectsDeps,
  args: RunLiveHostCommandArgs<TType>,
): Promise<HostDaemonCommandResult<TType>> {
  const execution =
    args.execution ?? createLiveHostCommandExecution(args.hostId);
  let command = args.command;
  let providerWorkCommand = isProviderWorkCommand(command) ? command : null;
  if (providerWorkCommand !== null) {
    const admitted = await awaitThreadWorkAdmission(deps, {
      command: providerWorkCommand,
      hostId: args.hostId,
      ...(args.admissionReason === undefined
        ? {}
        : { reason: args.admissionReason }),
    });
    command = admitted.command;
    providerWorkCommand = admitted.command;
  }
  try {
    const result = await callHostOnlineRpc(deps, {
      command,
      hostId: args.hostId,
      timeoutMs: args.timeoutMs,
    });
    await applyLiveHostCommandReport(deps, {
      command,
      execution,
      report: buildLiveHostCommandSuccessReport({
        command,
        completedAt: Date.now(),
        execution,
        result,
      }),
    });
    return result;
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    const failureReport = buildLiveHostCommandFailureReport({
      command,
      completedAt: Date.now(),
      error: normalized,
      execution,
    });
    try {
      await applyLiveHostCommandReport(deps, {
        command,
        execution,
        report: failureReport,
      });
    } catch (settlementError) {
      deps.logger.error(
        {
          err: settlementError,
          commandType: command.type,
          originalError: normalized,
        },
        "Live command failure settlement failed",
      );
    }
    throw normalized;
  } finally {
    if (providerWorkCommand !== null) {
      const thread = getThread(deps.db, providerWorkCommand.threadId);
      if (
        !thread ||
        (thread.status !== "active" && thread.status !== "stopping")
      ) {
        await releaseThreadWorkAdmission(deps, {
          terminalReason: thread
            ? `thread became ${thread.status}`
            : "thread deleted",
          threadId: providerWorkCommand.threadId,
        }).catch((error) => {
          deps.logger.warn(
            { err: error, threadId: providerWorkCommand.threadId },
            "Failed to release settled thread work admission",
          );
        });
      }
    }
  }
}

export function recoverDurableWorkAdmissions(
  deps: CommandResultSideEffectsDeps,
  args: { hostId?: string } = {},
): void {
  for (const entry of listRecoverableWorkAdmissionCommands(deps, args)) {
    // The daemon can reconnect while the original in-memory task is waiting
    // for durable workspace promotion (and therefore has no socket RPC to
    // reject). Starting a second loop for the same request would let both
    // share one idempotent reservation and race its release.
    if (hasActiveWorkAdmissionTask(deps, entry.command.requestId)) continue;
    startLiveHostCommand(deps, {
      admissionReason: entry.reason,
      command: entry.command,
      hostId: entry.hostId,
      timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
      onError: ({ error }) => {
        deps.logger.warn(
          { err: error, threadId: entry.command.threadId },
          "Recovered work admission command failed",
        );
      },
    });
  }
}

export function startLiveHostCommand<
  TType extends HostDaemonSettledCommandType,
>(
  deps: CommandResultSideEffectsDeps,
  args: StartLiveHostCommandArgs<TType>,
): void {
  const execution =
    args.execution ?? createLiveHostCommandExecution(args.hostId);
  const unregisterActiveTask = isProviderWorkCommand(args.command)
    ? registerActiveWorkAdmissionTask(deps, args.command.requestId)
    : null;
  void runLiveHostCommand(deps, { ...args, execution })
    .catch((error) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      const handlerArgs: LiveHostCommandErrorHandlerArgs<TType> = {
        command: args.command,
        error: normalized,
        execution,
        hostId: args.hostId,
      };
      const expectedErrorFields =
        expectedLiveHostCommandErrorLogFields(normalized);
      if (expectedErrorFields !== null) {
        deps.logger.debug(
          {
            ...liveHostCommandBaseLogFields(handlerArgs),
            ...expectedErrorFields,
          },
          "Expected live host command failure",
        );
        args.onExpectedError?.(handlerArgs);
        return;
      }
      args.onError?.(handlerArgs);
    })
    .finally(async () => {
      try {
        await args.onSettled?.();
      } catch (error) {
        deps.logger.error(
          { err: error, commandType: args.command.type },
          "Live command settled callback failed",
        );
      } finally {
        unregisterActiveTask?.();
      }
    });
}
