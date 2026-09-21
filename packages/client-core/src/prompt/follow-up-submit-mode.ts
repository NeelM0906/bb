export type FollowUpBlockedReason =
  | "loading-execution-options"
  | "loading-pending-interactions"
  | "pending-interaction"
  | "unavailable";

export type FollowUpSubmitMode =
  | { kind: "ready" }
  | { kind: "queue"; onStop: () => void }
  | { kind: "queue-while-stopping" }
  | { kind: "blocked"; reason: FollowUpBlockedReason };
