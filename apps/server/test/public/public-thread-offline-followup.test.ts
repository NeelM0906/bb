import { listEvents, listQueuedThreadMessages } from "@bb/db";
import { queuedMessageWaitingOnSchema } from "@bb/domain";
import { sendMessageResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { onDaemonSocketOpen } from "../../src/ws/daemon-protocol.js";
import {
  registerTestHostRpcCapture,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHost,
  seedProjectWithSource,
  seedQueuedMessage,
  seedSession,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("offline host follow-ups", () => {
  it("queues a follow-up to an existing idle thread until its host reconnects", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, {
        id: "host-offline-followup",
        name: "M5",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/offline-followup",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-offline-followup",
      });
      const input = [
        {
          type: "text" as const,
          text: "Continue when M5 reconnects",
          mentions: [],
        },
      ];
      const eventCountBeforeSend = listEvents(harness.db, {
        threadId: thread.id,
      }).length;

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input,
            mode: "steer-if-active",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = sendMessageResponseSchema.parse(await readJson(response));
      expect(body).toMatchObject({
        delivery: "queued",
        waitingOn: { kind: "host-offline", hostName: "M5" },
        sendAt: null,
      });
      if (body.delivery !== "queued") {
        throw new Error("expected the offline follow-up to queue");
      }

      const queued = listQueuedThreadMessages(harness.db, thread.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        id: body.queuedMessageId,
        sendAt: null,
        failureReason: null,
      });
      expect(
        queuedMessageWaitingOnSchema.parse(JSON.parse(queued[0]!.waitingOn!)),
      ).toEqual({ kind: "host-offline", hostName: "M5" });
      expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(
        eventCountBeforeSend,
      );

      const reconnectSession = seedSession(harness.deps, host.id);
      const reconnectSocket = registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: reconnectSession.id,
      });
      onDaemonSocketOpen(harness.deps, {
        hostId: host.id,
        sessionId: reconnectSession.id,
        socket: reconnectSocket,
      });

      const dispatched = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      if (dispatched.command.type !== "turn.submit") {
        throw new Error("expected the queued follow-up to dispatch");
      }
      expect(dispatched.command).toMatchObject({
        threadId: thread.id,
        input,
        target: { mode: "start" },
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(
        eventCountBeforeSend + 1,
      );
    });
  });

  it("holds the host-connected drain until admission reconciliation settles", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, {
        id: "host-offline-followup-reconcile",
        name: "M6",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/offline-followup-reconcile",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-offline-followup-reconcile",
      });
      const input = textInput("Continue once M6 reconciles");
      seedQueuedMessage(harness.deps, {
        content: input,
        threadId: thread.id,
        waitingOn: { kind: "host-offline", hostName: "M6" },
      });

      const reconnectSession = seedSession(harness.deps, host.id);
      const reconnectSocket = registerTestHostRpcCapture(harness.deps, {
        deferAdmissionReconcile: true,
        hostId: host.id,
        sessionId: reconnectSession.id,
      });
      onDaemonSocketOpen(harness.deps, {
        hostId: host.id,
        sessionId: reconnectSession.id,
        socket: reconnectSocket,
      });

      const reconcile = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.admission.reconcile",
      );
      const isFollowUpDispatch = ({ command }: { command: { type: string } }) =>
        command.type === "turn.submit" &&
        "threadId" in command &&
        command.threadId === thread.id;
      await expect(
        waitForQueuedCommand(harness, isFollowUpDispatch, 300),
      ).rejects.toThrow();
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);

      await reportQueuedCommandSuccess(harness, reconcile, {
        reservations: [],
      });

      const dispatched = await waitForQueuedCommand(
        harness,
        isFollowUpDispatch,
      );
      expect(dispatched.command).toMatchObject({
        threadId: thread.id,
        input,
        target: { mode: "start" },
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("keeps host-offline rows parked when admission reconciliation fails", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, {
        id: "host-offline-followup-reconcile-failure",
        name: "M7",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/offline-followup-reconcile-failure",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-offline-followup-reconcile-failure",
      });
      seedQueuedMessage(harness.deps, {
        content: textInput("Stay parked while M7 reconciles badly"),
        threadId: thread.id,
        waitingOn: { kind: "host-offline", hostName: "M7" },
      });

      const reconnectSession = seedSession(harness.deps, host.id);
      const reconnectSocket = registerTestHostRpcCapture(harness.deps, {
        deferAdmissionReconcile: true,
        hostId: host.id,
        sessionId: reconnectSession.id,
      });
      onDaemonSocketOpen(harness.deps, {
        hostId: host.id,
        sessionId: reconnectSession.id,
        socket: reconnectSocket,
      });

      const reconcile = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.admission.reconcile",
      );
      await reportQueuedCommandError(harness, reconcile, {
        errorCode: "internal",
        errorMessage: "admission ledger unavailable",
      });

      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" &&
            "threadId" in command &&
            command.threadId === thread.id,
          300,
        ),
      ).rejects.toThrow();
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
    });
  });
});
