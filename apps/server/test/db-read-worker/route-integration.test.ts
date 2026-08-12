import { insertEvents } from "@bb/db";
import { encodeClientTurnRequestIdNumber, threadScope } from "@bb/domain";
import {
  threadConversationOutlineResponseSchema,
  threadTimelineResponseSchema,
} from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import { readJson } from "../helpers/json.js";
import { seedThread, seedThreadFixture } from "../helpers/seed.js";
import { testLogger, withTestHarness } from "../helpers/test-app.js";

describe("database read worker production routes", () => {
  it("quietly terminates cancelled reads across worker-backed routes", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const loggedError = vi.spyOn(testLogger, "error");
      const paths = [
        "/api/v1/threads",
        "/api/v1/projects?include=threads",
        "/api/v1/sidebar-bootstrap",
        `/api/v1/threads/${thread.id}/timeline`,
        `/api/v1/threads/${thread.id}/conversation-outline`,
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=turn-1&sourceSeqStart=0&sourceSeqEnd=0`,
      ];

      for (const path of paths) {
        const abortController = new AbortController();
        abortController.abort();
        const response = await harness.app.request(
          new Request(`http://localhost${path}`, {
            signal: abortController.signal,
          }),
        );

        expect(response.status, path).toBe(499);
        await expect(readJson(response), path).resolves.toEqual({
          code: "client_closed_request",
          message: "Client closed request",
        });
      }
      expect(loggedError).not.toHaveBeenCalled();
    });
  });

  it("serves health while a production timeline route runs in the worker", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const eventCount = 1_200;
      insertEvents(
        harness.db,
        harness.hub,
        Array.from({ length: eventCount }, (_, index) => ({
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
                mentions: [],
                text: `route message ${index} ${"x".repeat(2_000)}`,
                type: "text",
              },
            ],
            request: { method: "turn/start", params: {} },
            requestId: encodeClientTurnRequestIdNumber({ value: index + 1 }),
            senderThreadId: null,
            source: "tell",
            target:
              index === 0 ? { kind: "thread-start" } : { kind: "new-turn" },
          }),
          itemId: null,
          itemKind: null,
          scope: threadScope(),
          sequence: index + 1,
          threadId: thread.id,
          type: "client/turn/requested" as const,
        })),
      );
      const workerCall = vi.spyOn(
        harness.deps.dbReadWorker,
        "timelineSnapshot",
      );

      const completionOrder: string[] = [];
      const timelineResponsePromise = Promise.resolve(
        harness.app.request(
          `/api/v1/threads/${thread.id}/timeline?segmentLimit=100`,
        ),
      ).then((response) => {
        completionOrder.push("timeline");
        return response;
      });
      const healthResponse = await harness.app.request("/health");
      completionOrder.push("health");
      const timelineResponse = await timelineResponsePromise;

      expect(healthResponse.status).toBe(200);
      expect(completionOrder[0]).toBe("health");
      expect(timelineResponse.status).toBe(200);
      threadTimelineResponseSchema.parse(await readJson(timelineResponse));
      expect(workerCall).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "timeline" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  }, 30_000);

  it("routes thread-list and sidebar thread snapshots through the worker", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project, thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      const workerCall = vi.spyOn(
        harness.deps.dbReadWorker,
        "threadListSnapshot",
      );
      const liveHostLookup = vi.spyOn(harness.hub, "getDaemonSessionIdForHost");

      const listResponse = await harness.app.request(
        `/api/v1/threads?projectId=${project.id}`,
      );
      expect(listResponse.status).toBe(200);
      await expect(readJson(listResponse)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: thread.id })]),
      );
      expect(workerCall).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "list",
          options: expect.objectContaining({ projectId: project.id }),
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(liveHostLookup).toHaveBeenCalledTimes(1);

      workerCall.mockClear();
      const projectsResponse = await harness.app.request(
        "/api/v1/projects?include=threads",
      );
      expect(projectsResponse.status).toBe(200);
      expect(workerCall).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "projects",
          projectIds: expect.arrayContaining([project.id]),
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      workerCall.mockClear();
      const sidebarResponse = await harness.app.request(
        "/api/v1/sidebar-bootstrap",
      );
      expect(sidebarResponse.status).toBe(200);
      expect(workerCall).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "projects",
          projectIds: expect.arrayContaining([project.id]),
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  it("routes outline and turn-summary projection through the worker", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const workerCall = vi.spyOn(
        harness.deps.dbReadWorker,
        "timelineSnapshot",
      );

      const outlineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/conversation-outline`,
      );
      expect(outlineResponse.status).toBe(200);
      threadConversationOutlineResponseSchema.parse(
        await readJson(outlineResponse),
      );
      expect(workerCall).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "conversationOutline" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      workerCall.mockClear();
      const summaryResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=turn-1&sourceSeqStart=0&sourceSeqEnd=0`,
      );
      expect(summaryResponse.status).toBe(400);
      await expect(readJson(summaryResponse)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(workerCall).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "turnSummaryDetails" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });
});
