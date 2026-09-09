import {
  getLastStoredProviderThreadId,
  listLatestThreadStateEventRowsByThreadIds,
  type DbQueryConnection,
  type DbTransaction,
  type StoredEventRow,
} from "@bb/db";
import {
  FIRST_PARTY_GOAL_EXTENSION_KIND,
  GOAL_EXTENSION_KINDS,
  threadScope,
  type DynamicTool,
  type Thread,
  type ThreadTimelineGoal,
  type ToolCallResponse,
} from "@bb/domain";
import { z } from "zod";
import { extractThreadTimelineGoal } from "@bb/thread-view";
import type { AppDeps } from "../../types.js";
import { parseStoredEvent } from "./thread-data.js";
import {
  appendThreadEvent,
  appendThreadEventInTransaction,
} from "./thread-events.js";

export type FirstPartyGoalSnapshotPayload = {
  objective: string;
  status: "active" | "paused" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
} | null;

interface AppendFirstPartyGoalSnapshotArgs {
  environmentId: string | null;
  payload: FirstPartyGoalSnapshotPayload;
  threadId: string;
}

export function listLatestGoalStateEventRowsByThreadIds(
  db: DbQueryConnection,
  threadIds: readonly string[],
): StoredEventRow[] {
  const latestByThreadId = new Map<string, StoredEventRow>();
  for (const kind of GOAL_EXTENSION_KINDS) {
    for (const row of listLatestThreadStateEventRowsByThreadIds(db, {
      threadIds,
      kind,
    })) {
      const existing = latestByThreadId.get(row.threadId);
      if (existing === undefined || row.sequence > existing.sequence) {
        latestByThreadId.set(row.threadId, row);
      }
    }
  }
  return [...latestByThreadId.values()];
}

export function loadThreadTimelineGoal(
  db: DbQueryConnection,
  threadId: string,
): ThreadTimelineGoal | null {
  return extractThreadTimelineGoal(
    listLatestGoalStateEventRowsByThreadIds(db, [threadId]).map((row) => ({
      event: parseStoredEvent(row),
      meta: {
        id: row.id,
        seq: row.sequence,
        createdAt: row.createdAt,
      },
    })),
  );
}

function buildFirstPartyGoalEventArgs(
  db: DbQueryConnection,
  args: AppendFirstPartyGoalSnapshotArgs,
) {
  const providerThreadId = getLastStoredProviderThreadId(db, args.threadId);
  return {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: "thread/extensionState/updated" as const,
    scope: threadScope(),
    providerThreadId,
    data: {
      kind: FIRST_PARTY_GOAL_EXTENSION_KIND,
      payload: args.payload,
      providerThreadId: providerThreadId ?? "",
    },
  };
}

export function appendFirstPartyGoalSnapshot(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendFirstPartyGoalSnapshotArgs,
): number {
  return appendThreadEvent(deps, buildFirstPartyGoalEventArgs(deps.db, args));
}

export function appendFirstPartyGoalSnapshotInTransaction(
  tx: DbTransaction,
  args: AppendFirstPartyGoalSnapshotArgs,
): number {
  return appendThreadEventInTransaction(
    tx,
    buildFirstPartyGoalEventArgs(tx, args),
  );
}

export function clearPersistedThreadGoalIfPresent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { environmentId: string | null; threadId: string },
): void {
  if (loadThreadTimelineGoal(deps.db, args.threadId) === null) {
    return;
  }
  appendFirstPartyGoalSnapshot(deps, {
    environmentId: args.environmentId,
    payload: null,
    threadId: args.threadId,
  });
}

export const COMPLETE_GOAL_TOOL_NAME = "goal.complete";

export const COMPLETE_GOAL_INSTRUCTIONS =
  "A first-party Goal is active on this thread. Keep working toward that objective across turns. When the objective is fully complete, call `goal.complete`. Do not call it for partial progress.";

const completeGoalInputSchema = z
  .object({
    summary: z.string().trim().min(1).optional(),
  })
  .strict();

export const COMPLETE_GOAL_TOOL: DynamicTool = {
  name: COMPLETE_GOAL_TOOL_NAME,
  description:
    "Mark the active first-party Goal complete. Call this only when the objective is fully done.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Optional short summary of what completed the Goal.",
      },
    },
    additionalProperties: false,
  },
  presentation: {
    label: {
      pending: "Completing the Goal",
      completed: "Completed the Goal",
    },
    icon: { glyph: "Target" },
  },
};

function toolCallTextResponse(
  success: boolean,
  text: string,
): ToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

export function handleCompleteGoalToolCall(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { input: unknown; thread: Thread },
): ToolCallResponse {
  const parsed = completeGoalInputSchema.safeParse(args.input ?? {});
  if (!parsed.success) {
    return toolCallTextResponse(false, "goal.complete arguments are invalid.");
  }
  const goal = loadThreadTimelineGoal(deps.db, args.thread.id);
  if (goal === null || goal.status !== "active") {
    return toolCallTextResponse(
      false,
      "No active first-party Goal to complete.",
    );
  }
  appendFirstPartyGoalSnapshot(deps, {
    environmentId: args.thread.environmentId,
    payload: {
      objective: goal.objective,
      status: "complete",
      tokenBudget: goal.tokenBudget,
      tokensUsed: goal.tokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds,
    },
    threadId: args.thread.id,
  });
  const summary = parsed.data.summary;
  return toolCallTextResponse(
    true,
    summary === undefined
      ? "Goal marked complete."
      : `Goal marked complete: ${summary}`,
  );
}
