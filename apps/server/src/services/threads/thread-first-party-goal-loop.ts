import { getThread, listEvents } from "@bb/db";
import type { ThreadTurnInitiator } from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { providerIdHasNativeGoal } from "./provider-command-typeahead.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import {
  appendFirstPartyGoalSnapshot,
  loadThreadTimelineGoal,
} from "./thread-first-party-goal.js";
import { sendThreadMessage } from "./thread-send.js";
import { z } from "zod";

export const FIRST_PARTY_GOAL_CONTINUE_PROMPT =
  "Continue the active Goal. Call goal.complete when the objective is fully done.";

export const FIRST_PARTY_GOAL_STALL_LIMIT = 2;

const GOAL_PROGRESS_ITEM_KINDS = new Set([
  "backgroundTask",
  "commandExecution",
  "delegation",
  "fileChange",
  "fileRead",
  "imageGeneration",
  "search",
  "toolCall",
  "webFetch",
  "webSearch",
]);

function turnHadProgress(
  events: readonly {
    itemKind: string | null;
    sequence: number;
    type: string;
  }[],
  turnStartSequence: number,
  turnEndSequence: number,
): boolean {
  return events.some(
    (event) =>
      event.sequence > turnStartSequence &&
      event.sequence <= turnEndSequence &&
      event.itemKind !== null &&
      GOAL_PROGRESS_ITEM_KINDS.has(event.itemKind),
  );
}

const requestInitiatorSchema = z.object({
  initiator: z.enum(["user", "agent", "system"]),
});

function requestInitiator(data: string): ThreadTurnInitiator | null {
  try {
    const parsed = requestInitiatorSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data.initiator : null;
  } catch {
    return null;
  }
}

function countTrailingContinuationStalls(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  args: { afterSequence: number; threadId: string },
): number {
  const events = listEvents(deps.db, {
    threadId: args.threadId,
    afterSequence: args.afterSequence,
  });
  const completedTurns = events.flatMap((event) => {
    if (event.type !== "turn/completed") return [];
    const request = [...events]
      .reverse()
      .find(
        (candidate) =>
          candidate.sequence < event.sequence &&
          candidate.type === "client/turn/requested",
      );
    if (request === undefined) return [];
    return [
      {
        endSequence: event.sequence,
        initiator: requestInitiator(request.data),
        startSequence: request.sequence,
      },
    ];
  });

  let stalls = 0;
  for (const turn of [...completedTurns].reverse()) {
    if (turn.initiator !== "system") break;
    if (turnHadProgress(events, turn.startSequence, turn.endSequence)) break;
    stalls += 1;
  }
  return stalls;
}

export async function maybeContinueFirstPartyGoal(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
): Promise<void> {
  const thread = getThread(deps.db, threadId);
  if (
    thread === null ||
    thread.status !== "idle" ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null
  ) {
    return;
  }
  if (providerIdHasNativeGoal(deps.providerRegistry, thread.providerId)) {
    return;
  }
  if (deps.pendingInteractions.hasPendingThreadInteraction(threadId)) {
    return;
  }
  const goal = loadThreadTimelineGoal(deps.db, threadId);
  if (goal === null || goal.status !== "active") {
    return;
  }

  const stalls = countTrailingContinuationStalls(deps, {
    afterSequence: goal.sourceSeq,
    threadId,
  });
  if (stalls >= FIRST_PARTY_GOAL_STALL_LIMIT) {
    appendFirstPartyGoalSnapshot(deps, {
      environmentId: thread.environmentId,
      payload: {
        objective: goal.objective,
        status: "paused",
        tokenBudget: goal.tokenBudget,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
      },
      threadId,
    });
    return;
  }

  const environment = await requireThreadCommandEnvironment(deps, { thread });
  await sendThreadMessage(deps, {
    environment,
    initiator: "system",
    payload: {
      mode: "start",
      input: [
        {
          type: "text",
          text: FIRST_PARTY_GOAL_CONTINUE_PROMPT,
          mentions: [],
        },
      ],
    },
    thread,
    trigger: "auto-dispatch",
  });
}
