import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendStoredThreadEvent,
  createConnection,
  createProject,
  createThread,
  insertEvents,
  listThreadsWithPendingInteractionState,
  migrate,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import { createDbReadWorkerService } from "../../src/db-read-worker/service.js";
import { buildThreadTimelineWithProfile } from "../../src/services/threads/timeline.js";
import { toThreadListEntryResponses } from "../../src/services/threads/thread-runtime-display.js";
import { DEFAULT_MAX_INLINE_OUTPUT_CHARS } from "../../src/services/threads/timeline-output-truncation.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function setupFileDatabase(eventCount: number, planCommandRequested = false) {
  const directory = mkdtempSync(join(tmpdir(), "bb-read-worker-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "bb.db");
  const db = createConnection(databasePath);
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "worker-test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "worker-test-project",
    source: { type: "local_path", hostId: host.id, path: directory },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "claude-code",
    status: planCommandRequested ? "active" : "starting",
  });
  const events: Parameters<typeof insertEvents>[2] = Array.from(
    { length: eventCount },
    (_, index) => ({
      data: JSON.stringify({
        direction: "outbound",
        execution: {
          model: "test-model",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        initiator: "user",
        input: [
          {
            mentions: planCommandRequested
              ? [
                  {
                    start: 0,
                    end: 5,
                    resource: {
                      kind: "command",
                      trigger: "/",
                      name: "plan",
                      source: "command",
                      origin: "user",
                      label: "plan",
                      argumentHint: null,
                    },
                  },
                ]
              : [],
            text: planCommandRequested
              ? "/plan inspect the failure"
              : `message ${index} ${"x".repeat(1_000)}`,
            type: "text",
          },
        ],
        request: { method: "turn/start", params: {} },
        requestId: encodeClientTurnRequestIdNumber({ value: index + 1 }),
        senderThreadId: null,
        source: "tell",
        target: index === 0 ? { kind: "thread-start" } : { kind: "new-turn" },
      }),
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      scope: threadScope(),
      sequence: index + 1,
      threadId: thread.id,
      type: "client/turn/requested" as const,
    }),
  );
  insertEvents(db, noopNotifier, events);
  return { databasePath, db, thread };
}

describe("database read worker timeline snapshot", () => {
  it.each(["collapse", "flat"] as const)(
    "matches the direct file-backed timeline projection (%s)",
    async (completedTurnDisplay) => {
      const eventCount = 200;
      const { databasePath, db, thread } = setupFileDatabase(eventCount);
      const options = {
        completedTurnDisplay,
        eventBudget: 10_000,
        includeNestedRows: false,
        includeDiagnosticOperations: false,
        maxInlineOutputChars: 10_000,
        planCommand: null,
        maxSeq: eventCount,
        page: { kind: "latest" as const, segmentLimit: 20 },
      };
      const direct = buildThreadTimelineWithProfile(
        db,
        thread,
        options,
      ).response;
      const service = createDbReadWorkerService({
        databasePath,
      });

      const result = await service.timelineSnapshot({
        kind: "timeline",
        options: {
          completedTurnDisplay: options.completedTurnDisplay,
          eventBudget: options.eventBudget,
          includeNestedRows: options.includeNestedRows,
          includeDiagnosticOperations: options.includeDiagnosticOperations,
          maxInlineOutputChars: options.maxInlineOutputChars,
          planCommand: null,
          page: options.page,
        },
        threadId: thread.id,
      });

      expect(result.kind).toBe("timeline");
      if (result.kind === "timeline") {
        expect(result.response).toEqual(direct);
      }
      await service.shutdown();
      db.$client.close();
    },
    20_000,
  );

  it("preserves the active provider plan command in the worker projection", async () => {
    const { databasePath, db, thread } = setupFileDatabase(1, true);
    const service = createDbReadWorkerService({ databasePath });
    try {
      appendStoredThreadEvent(db, noopNotifier, {
        threadId: thread.id,
        scope: turnScope("turn-plan"),
        providerThreadId: "provider-plan",
        type: "turn/started",
        data: { providerThreadId: "provider-plan" },
      });
      appendStoredThreadEvent(db, noopNotifier, {
        threadId: thread.id,
        scope: turnScope("turn-plan"),
        providerThreadId: "provider-plan",
        type: "turn/input/accepted",
        data: {
          providerThreadId: "provider-plan",
          clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
        },
      });
      const options = {
        completedTurnDisplay: "collapse" as const,
        eventBudget: 10_000,
        includeDiagnosticOperations: false,
        maxInlineOutputChars: 10_000,
        page: { kind: "latest" as const, segmentLimit: 20 },
        planCommand: { trigger: "/" as const, name: "plan", trailingText: " " },
      };
      const direct = buildThreadTimelineWithProfile(db, thread, {
        ...options,
        maxSeq: 3,
      }).response;
      expect(direct.activePromptMode).toEqual({
        mode: "plan",
        providerId: "claude-code",
        prompt: "inspect the failure",
      });
      const result = await service.timelineSnapshot({
        kind: "timeline",
        threadId: thread.id,
        options,
      });
      expect(result.kind).toBe("timeline");
      if (result.kind === "timeline") expect(result.response).toEqual(direct);
    } finally {
      await service.shutdown();
      db.$client.close();
    }
  }, 20_000);

  it("matches the direct file-backed thread-list projection", async () => {
    const { databasePath, db, thread } = setupFileDatabase(10);
    const now = 1_000;
    const options = { projectId: thread.projectId };
    const direct = toThreadListEntryResponses(
      {
        db,
        hub: { getDaemonSessionIdForHost: () => null },
      },
      {
        now,
        threads: listThreadsWithPendingInteractionState(db, options),
      },
    );
    const service = createDbReadWorkerService({ databasePath });

    await expect(
      service.threadListSnapshot({ kind: "list", now, options }),
    ).resolves.toEqual(direct);

    await service.shutdown();
    db.$client.close();
  }, 20_000);

  it("returns one bounded snapshot while a WAL writer appends", async () => {
    const eventCount = 500;
    const { databasePath, db, thread } = setupFileDatabase(eventCount);
    const options = {
      completedTurnDisplay: "collapse" as const,
      eventBudget: 10_000,
      includeNestedRows: false,
      includeDiagnosticOperations: false,
      maxInlineOutputChars: 10_000,
      planCommand: null,
      maxSeq: eventCount,
      page: { kind: "latest" as const, segmentLimit: eventCount },
    };
    const beforeWrite = buildThreadTimelineWithProfile(
      db,
      thread,
      options,
    ).response;
    const service = createDbReadWorkerService({ databasePath });
    await service.ready();

    const snapshotPromise = service.timelineSnapshot({
      kind: "timeline",
      options: {
        completedTurnDisplay: options.completedTurnDisplay,
        eventBudget: options.eventBudget,
        includeNestedRows: options.includeNestedRows,
        includeDiagnosticOperations: options.includeDiagnosticOperations,
        maxInlineOutputChars: options.maxInlineOutputChars,
        planCommand: null,
        page: options.page,
      },
      threadId: thread.id,
    });
    insertEvents(db, noopNotifier, [
      {
        data: JSON.stringify({ text: "concurrent writer" }),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        scope: threadScope(),
        sequence: eventCount + 1,
        threadId: thread.id,
        type: "system/manager/user_message",
      },
    ]);
    const afterWrite = buildThreadTimelineWithProfile(db, thread, {
      ...options,
      maxSeq: eventCount + 1,
    }).response;
    const snapshot = await snapshotPromise;

    expect(snapshot.kind).toBe("timeline");
    if (snapshot.kind === "timeline") {
      if (snapshot.response.maxSeq === eventCount) {
        expect(snapshot.response).toEqual(beforeWrite);
      } else {
        expect(snapshot.response.maxSeq).toBe(eventCount + 1);
        expect(snapshot.response).toEqual(afterWrite);
      }
    }
    await service.shutdown();
    db.$client.close();
  }, 20_000);

  it("keeps the event loop responsive during a large timeline projection", async () => {
    const eventCount = 800;
    const { databasePath, db, thread } = setupFileDatabase(eventCount);
    const service = createDbReadWorkerService({
      databasePath,
    });
    await service.ready();
    const completionOrder: string[] = [];
    const read = service
      .timelineSnapshot({
        kind: "timeline",
        options: {
          completedTurnDisplay: "collapse" as const,
          eventBudget: 10_000,
          includeNestedRows: false,
          includeDiagnosticOperations: false,
          maxInlineOutputChars: 10_000,
          planCommand: null,
          page: { kind: "latest", segmentLimit: eventCount },
        },
        threadId: thread.id,
      })
      .then(() => completionOrder.push("read"));
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        completionOrder.push("timer");
        resolve();
      }, 0);
    });

    await Promise.all([read, timer]);
    expect(completionOrder[0]).toBe("timer");
    await service.shutdown();
    db.$client.close();
  }, 20_000);

  it("truncates nested oversized output in the worker without blocking a timer", async () => {
    const { databasePath, db, thread } = setupFileDatabase(10);
    const oversizedDiff = "z".repeat(DEFAULT_MAX_INLINE_OUTPUT_CHARS * 64);
    const providerThreadId = "provider-thread-oversized";
    insertEvents(db, noopNotifier, [
      {
        data: JSON.stringify({}),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        providerThreadId,
        scope: turnScope("turn-oversized"),
        sequence: 11,
        threadId: thread.id,
        type: "turn/started",
      },
      {
        data: JSON.stringify({
          item: {
            approvalStatus: null,
            changes: [
              { diff: oversizedDiff, kind: "update", path: "src/large.ts" },
            ],
            id: "file-change-oversized",
            status: "completed",
            type: "fileChange",
          },
        }),
        itemId: "file-change-oversized",
        itemKind: "fileChange",
        parentToolCallId: null,
        providerThreadId,
        scope: turnScope("turn-oversized"),
        sequence: 12,
        threadId: thread.id,
        type: "item/completed",
      },
      {
        data: JSON.stringify({ status: "completed" }),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        providerThreadId,
        scope: turnScope("turn-oversized"),
        sequence: 13,
        threadId: thread.id,
        type: "turn/completed",
      },
    ]);
    const service = createDbReadWorkerService({ databasePath });
    await service.ready();
    const completionOrder: string[] = [];
    const snapshotPromise = service
      .timelineSnapshot({
        kind: "timeline",
        options: {
          completedTurnDisplay: "collapse" as const,
          eventBudget: 10_000,
          includeNestedRows: true,
          includeDiagnosticOperations: false,
          maxInlineOutputChars: DEFAULT_MAX_INLINE_OUTPUT_CHARS,
          planCommand: null,
          page: { kind: "latest", segmentLimit: 20 },
        },
        threadId: thread.id,
      })
      .then((snapshot) => {
        completionOrder.push("read");
        return snapshot;
      });
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        completionOrder.push("timer");
        resolve();
      }, 0);
    });

    const [snapshot] = await Promise.all([snapshotPromise, timer]);
    expect(completionOrder[0]).toBe("timer");
    expect(snapshot.kind).toBe("timeline");
    if (snapshot.kind === "timeline") {
      const serialized = JSON.stringify(snapshot.response.rows);
      expect(serialized).toContain("more characters truncated");
      expect(serialized).not.toContain(oversizedDiff);
    }
    await service.shutdown();
    db.$client.close();
  }, 20_000);
});
