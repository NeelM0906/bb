import { threadChildOriginSchema, threadOriginKindSchema } from "@bb/domain";
import {
  threadConversationOutlineResponseSchema,
  threadListResponseSchema,
  threadTimelineResponseSchema,
  timelineTurnSummaryDetailsResponseSchema,
} from "@bb/server-contract";
import { z } from "zod";

const timelineCursorSchema = z
  .object({
    anchorId: z.string(),
    anchorSeq: z.number().int().nonnegative(),
  })
  .strict();

const timelinePageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("latest"),
      segmentLimit: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      beforeCursor: timelineCursorSchema,
      kind: z.literal("older"),
      segmentLimit: z.number().int().positive(),
    })
    .strict(),
]);

const timelineBuildOptionsSchema = z
  .object({
    eventBudget: z.number().int().positive(),
    includeNestedRows: z.boolean().optional(),
    includeProviderUnhandledOperations: z.boolean(),
    maxInlineOutputChars: z.number().int().nonnegative().nullable(),
    page: timelinePageSchema,
    providerDisplayName: z.string().optional(),
    summaryOnly: z.boolean().optional(),
  })
  .strict();

export const timelineSnapshotInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("timeline"),
      options: timelineBuildOptionsSchema,
      threadId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("conversationOutline"),
      providerDisplayName: z.string().optional(),
      threadId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      includeProviderUnhandledOperations: z.boolean(),
      kind: z.literal("turnSummaryDetails"),
      providerDisplayName: z.string().optional(),
      sourceSeqEnd: z.number().int().nonnegative(),
      sourceSeqStart: z.number().int().nonnegative(),
      threadId: z.string().min(1),
      turnId: z.string().min(1),
    })
    .strict(),
]);

const threadListOptionsSchema = z
  .object({
    archived: z.boolean().optional(),
    childOrigin: threadChildOriginSchema.optional(),
    hasParent: z.boolean().optional(),
    includeHidden: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    originKind: threadOriginKindSchema.optional(),
    originPluginId: z.string().min(1).optional(),
    parentThreadId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    sectionId: z.string().min(1).optional(),
    sourceThreadId: z.string().min(1).optional(),
    unsectioned: z.boolean().optional(),
  })
  .strict();

export const threadListSnapshotInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("list"),
      now: z.number().finite(),
      options: threadListOptionsSchema,
    })
    .strict(),
  z
    .object({
      archived: z.boolean().optional(),
      kind: z.literal("projects"),
      now: z.number().finite(),
      projectIds: z.array(z.string().min(1)),
    })
    .strict(),
]);

const threadTimelineBuildProfileSchema = z
  .object({
    compactedEventCount: z.number().int().nonnegative(),
    contextWindowEventDataBytes: z.number().int().nonnegative(),
    contextWindowEventRowCount: z.number().int().nonnegative(),
    decodedEventCount: z.number().int().nonnegative(),
    eventDataBytes: z.number().int().nonnegative(),
    eventRowCount: z.number().int().nonnegative(),
    pageKind: z.enum(["latest", "older"]),
    projectedRowCount: z.number().int().nonnegative(),
    responseJsonBytes: z.number().int().nonnegative().nullable(),
    responseRowCount: z.number().int().nonnegative(),
    returnedSegmentCount: z.number().int().nonnegative(),
    segmentLimit: z.number().int().positive(),
    selectionStrategy: z.enum(["full", "standard-window"]),
    stageTimings: z.array(
      z
        .object({
          durationMs: z.number().nonnegative(),
          stage: z.enum([
            "event-query",
            "accepted-client-request-context-query",
            "event-json-decode",
            "summary-compaction",
            "context-window-query",
            "context-window-json-decode",
            "thread-view-projection",
            "pagination-segmentation",
            "response-serialization",
          ]),
        })
        .strict(),
    ),
    totalDurationMs: z.number().nonnegative(),
  })
  .strict();

export const timelineSnapshotResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("timeline"),
      profile: threadTimelineBuildProfileSchema,
      response: threadTimelineResponseSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("conversationOutline"),
      response: threadConversationOutlineResponseSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("turnSummaryDetails"),
      response: timelineTurnSummaryDetailsResponseSchema,
    })
    .strict(),
]);

export const threadListSnapshotResultSchema = threadListResponseSchema;

export const dbReadWorkerRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      input: timelineSnapshotInputSchema,
      operation: z.literal("timelineSnapshot"),
      requestId: z.string().min(1),
      type: z.literal("request"),
    })
    .strict(),
  z
    .object({
      input: threadListSnapshotInputSchema,
      operation: z.literal("threadListSnapshot"),
      requestId: z.string().min(1),
      type: z.literal("request"),
    })
    .strict(),
]);

const workerReadyMessageSchema = z
  .object({ type: z.literal("ready") })
  .strict();
const workerOperationErrorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      code: z.string().min(1),
      details: z.unknown().optional(),
      kind: z.literal("api"),
      message: z.string(),
      retryable: z.boolean().optional(),
      status: z.union([z.literal(400), z.literal(413), z.literal(500)]),
    })
    .strict(),
  z
    .object({
      code: z.string().min(1),
      kind: z.literal("internal"),
      message: z.string(),
    })
    .strict(),
]);
const workerErrorMessageSchema = z
  .object({
    error: workerOperationErrorSchema,
    operation: z.enum(["timelineSnapshot", "threadListSnapshot"]),
    requestId: z.string().min(1),
    type: z.literal("error"),
  })
  .strict();
const workerTimelineResultMessageSchema = z
  .object({
    operation: z.literal("timelineSnapshot"),
    requestId: z.string().min(1),
    result: timelineSnapshotResultSchema,
    type: z.literal("result"),
  })
  .strict();
const workerThreadListResultMessageSchema = z
  .object({
    operation: z.literal("threadListSnapshot"),
    requestId: z.string().min(1),
    result: threadListSnapshotResultSchema,
    type: z.literal("result"),
  })
  .strict();

export const dbReadWorkerResponseSchema = z.union([
  workerReadyMessageSchema,
  workerErrorMessageSchema,
  workerTimelineResultMessageSchema,
  workerThreadListResultMessageSchema,
]);

export type DbReadWorkerRequest = z.infer<typeof dbReadWorkerRequestSchema>;
export type DbReadWorkerResponse = z.infer<typeof dbReadWorkerResponseSchema>;
export type ThreadListSnapshotInput = z.infer<
  typeof threadListSnapshotInputSchema
>;
export type ThreadListSnapshotResult = z.infer<
  typeof threadListSnapshotResultSchema
>;
export type TimelineSnapshotInput = z.infer<typeof timelineSnapshotInputSchema>;
export type TimelineSnapshotResult = z.infer<
  typeof timelineSnapshotResultSchema
>;
