import { isMainThread, parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@bb/db";
import {
  getLatestThreadSequence,
  getThread,
  listThreadsWithPendingInteractionState,
  listThreadsWithPendingInteractionStateForProjects,
} from "@bb/db";
import { toThreadListEntryResponses } from "../services/threads/thread-runtime-display.js";
import {
  buildThreadConversationOutline,
  buildThreadTimelineWithProfile,
  buildTimelineTurnSummaryDetails,
} from "../services/threads/timeline.js";
import {
  DEFAULT_MAX_INLINE_OUTPUT_CHARS,
  truncateTimelineResponseOutputs,
} from "../services/threads/timeline-output-truncation.js";
import {
  dbReadWorkerRequestSchema,
  dbReadWorkerResponseSchema,
  type DbReadWorkerRequest,
  type DbReadWorkerResponse,
  type TimelineSnapshotResult,
} from "./protocol.js";
import { ApiError } from "../errors.js";

interface DbReadWorkerData {
  databasePath: string;
  role: "db-read-worker";
}

function parseWorkerData(value: unknown): DbReadWorkerData {
  if (
    value === null ||
    typeof value !== "object" ||
    !("role" in value) ||
    value.role !== "db-read-worker" ||
    !("databasePath" in value) ||
    typeof value.databasePath !== "string" ||
    value.databasePath.length === 0
  ) {
    throw new Error("Invalid database read worker startup data");
  }
  return { databasePath: value.databasePath, role: value.role };
}

type DbReadWorkerError = Extract<
  DbReadWorkerResponse,
  { type: "error" }
>["error"];
type DbReadWorkerApiError = Extract<DbReadWorkerError, { kind: "api" }>;

function serializeApiError(
  error: ApiError,
  status: DbReadWorkerApiError["status"],
): DbReadWorkerApiError {
  return {
    code: error.body.code,
    ...(error.body.details === undefined
      ? {}
      : { details: error.body.details }),
    kind: "api",
    message: error.body.message,
    ...(error.body.retryable === undefined
      ? {}
      : { retryable: error.body.retryable }),
    status,
  };
}

function serializeError(error: unknown): DbReadWorkerError {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return serializeApiError(error, 400);
      case 413:
        return serializeApiError(error, 413);
      case 500:
        return serializeApiError(error, 500);
    }
  }
  if (error instanceof Error) {
    return {
      code: "db_read_failed",
      kind: "internal",
      message: error.message,
    };
  }
  return {
    code: "db_read_failed",
    kind: "internal",
    message: "Unknown database read failure",
  };
}

export function runDbReadWorker(): void {
  if (!parentPort) {
    throw new Error("Database read worker requires a parent port");
  }
  const port = parentPort;
  const { databasePath } = parseWorkerData(workerData);
  const sqlite = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  sqlite.pragma("query_only = ON");
  const db = drizzle({ client: sqlite, schema });
  const readSnapshot = sqlite.transaction(
    (request: DbReadWorkerRequest): TimelineSnapshotResult | unknown[] => {
      if (request.operation === "timelineSnapshot") {
        const input = request.input;
        const thread = getThread(db, input.threadId);
        if (!thread) {
          throw new Error(
            `Database read worker thread not found: ${input.threadId}`,
          );
        }
        switch (input.kind) {
          case "timeline": {
            const maxSeq = getLatestThreadSequence(db, {
              threadId: thread.id,
            });
            const result = buildThreadTimelineWithProfile(db, thread, {
              ...input.options,
              maxSeq,
            });
            return {
              kind: "timeline",
              profile: result.profile,
              response: truncateTimelineResponseOutputs(
                result.response,
                DEFAULT_MAX_INLINE_OUTPUT_CHARS,
              ),
            };
          }
          case "conversationOutline":
            return {
              kind: "conversationOutline",
              response: buildThreadConversationOutline(db, thread, {
                maxSeq: getLatestThreadSequence(db, { threadId: thread.id }),
                providerDisplayName: input.providerDisplayName,
              }),
            };
          case "turnSummaryDetails":
            return {
              kind: "turnSummaryDetails",
              response: buildTimelineTurnSummaryDetails(db, thread, {
                includeProviderUnhandledOperations:
                  input.includeProviderUnhandledOperations,
                providerDisplayName: input.providerDisplayName,
                sourceSeqEnd: input.sourceSeqEnd,
                sourceSeqStart: input.sourceSeqStart,
                turnId: input.turnId,
              }),
            };
        }
      }

      const input = request.input;
      const threads =
        input.kind === "list"
          ? listThreadsWithPendingInteractionState(db, input.options)
          : listThreadsWithPendingInteractionStateForProjects(db, {
              archived: input.archived,
              projectIds: input.projectIds,
            });
      return toThreadListEntryResponses(
        {
          db,
          hub: { getDaemonSessionIdForHost: () => null },
        },
        { now: input.now, threads },
      );
    },
  );

  port.on("message", (value: unknown) => {
    const parsed = dbReadWorkerRequestSchema.safeParse(value);
    if (!parsed.success) {
      port.postMessage({
        error: {
          code: "invalid_request",
          message: "Invalid database read worker request",
        },
        operation: "timelineSnapshot",
        requestId: "invalid",
        type: "error",
      });
      return;
    }
    const request = parsed.data;
    try {
      const response = dbReadWorkerResponseSchema.parse({
        operation: request.operation,
        requestId: request.requestId,
        result: readSnapshot.deferred(request),
        type: "result",
      });
      port.postMessage(response);
    } catch (error) {
      port.postMessage(
        dbReadWorkerResponseSchema.parse({
          error: serializeError(error),
          operation: request.operation,
          requestId: request.requestId,
          type: "error",
        }),
      );
    }
  });
  port.once("close", () => sqlite.close());
  port.postMessage(dbReadWorkerResponseSchema.parse({ type: "ready" }));
}

if (!isMainThread) {
  runDbReadWorker();
}
