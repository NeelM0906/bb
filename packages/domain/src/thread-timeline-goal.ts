import { z } from "zod";
import { LEGACY_CODEX_GOAL_EXTENSION_KIND } from "./legacy-thread-events.js";

export const FIRST_PARTY_GOAL_EXTENSION_KIND = "bb/goal";

export const GOAL_EXTENSION_KINDS = [
  LEGACY_CODEX_GOAL_EXTENSION_KIND,
  FIRST_PARTY_GOAL_EXTENSION_KIND,
] as const;

export function isGoalExtensionKind(
  kind: string,
): kind is (typeof GOAL_EXTENSION_KINDS)[number] {
  return (GOAL_EXTENSION_KINDS as readonly string[]).includes(kind);
}

export const threadTimelineGoalStatusSchema = z.enum([
  "active",
  "paused",
  "budgetLimited",
  "complete",
]);

export const threadTimelineGoalSchema = z.object({
  sourceSeq: z.number().int().nonnegative(),
  updatedAt: z.number(),
  objective: z.string(),
  status: threadTimelineGoalStatusSchema,
  tokenBudget: z.number().nullable(),
  tokensUsed: z.number(),
  timeUsedSeconds: z.number(),
});
export type ThreadTimelineGoal = z.infer<typeof threadTimelineGoalSchema>;
