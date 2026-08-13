import {
  acquireUnmanagedWorkspaceMutationLease,
  acquireUnmanagedWorkspaceMutationLeaseAndStartAdmission,
  clearEnvironmentPathCanonicalizationsForHost,
  createWorkAdmission,
  getEnvironment,
  getCurrentThreadWorkAdmission,
  getThread,
  getWorkAdmission,
  getUnmanagedWorkspaceMutationLease,
  getUnmanagedWorkspaceMutationLeaseForThread,
  getUnmanagedWorkspaceMutationWaitState,
  markThreadDeleted,
  releaseUnmanagedWorkspaceMutationLease,
  recordEnvironmentCanonicalPath,
  updateProject,
} from "@bb/db";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import {
  listRecoverableWorkAdmissionCommands,
  reconcileHostWorkAdmissions,
  releaseThreadWorkAdmission,
  releaseWorkspaceLeaseForThreadInTransaction,
} from "../../src/services/threads/work-admission.js";
import { finalizeStoppedThread } from "../../src/services/threads/thread-lifecycle.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import { buildThreadStartCommand } from "../../src/services/threads/thread-commands.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  recoverDurableWorkAdmissions,
  runLiveHostCommand,
} from "../../src/services/hosts/live-command.js";
import {
  listQueuedCommands,
  listQueuedThreadCommands,
  registerTestHostRpcCapture,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("protected unmanaged workspace dispatch", () => {
  it("cleans a promoted lease whose recovered command is invalid", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHostSession(harness.deps, {
        id: "host-workspace-invalid-recovery",
      }).host;
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/canonical/invalid-recovery-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/canonical/invalid-recovery-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const holder = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const invalid = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      for (const [id, threadId, commandJson] of [
        ["req-invalid-holder", holder.id, "{}"],
        ["req-invalid-promoted", invalid.id, '{"type":"removed.command"}'],
      ] as const) {
        createWorkAdmission(harness.db, {
          commandJson,
          hostId: host.id,
          id,
          reason: "interactive",
          threadId,
          waitingReason: "Awaiting host capacity",
        });
      }
      expect(
        acquireUnmanagedWorkspaceMutationLease(harness.db, {
          environmentId: environment.id,
          requestId: "req-invalid-holder",
          threadId: holder.id,
        }),
      ).toMatchObject({ outcome: "acquired", generation: 1 });
      expect(
        acquireUnmanagedWorkspaceMutationLease(harness.db, {
          environmentId: environment.id,
          requestId: "req-invalid-promoted",
          threadId: invalid.id,
        }),
      ).toMatchObject({ outcome: "waiting" });
      expect(
        releaseUnmanagedWorkspaceMutationLease(harness.db, {
          canonicalPath: "/canonical/invalid-recovery-repo",
          generation: 1,
          hostId: host.id,
          reason: "promote invalid recovery",
        }),
      ).toMatchObject({
        promoted: { requestId: "req-invalid-promoted", generation: 2 },
      });

      expect(
        listRecoverableWorkAdmissionCommands(harness.deps, {
          hostId: host.id,
        }),
      ).toEqual([]);
      expect(
        getWorkAdmission(harness.db, "req-invalid-promoted"),
      ).toMatchObject({ status: "terminal" });
      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, invalid.id),
      ).toBeNull();
    });
  });

  it("promotes a workspace waiter before deleting its holder thread", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHostSession(harness.deps, {
        id: "host-workspace-holder-delete",
      }).host;
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/canonical/deleted-holder-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/canonical/deleted-holder-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const holder = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const waiter = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      for (const [id, threadId] of [
        ["req-deleted-holder", holder.id],
        ["req-deleted-waiter", waiter.id],
      ] as const) {
        createWorkAdmission(harness.db, {
          commandJson: "{}",
          hostId: host.id,
          id,
          reason: "interactive",
          threadId,
          waitingReason: "Awaiting host capacity",
        });
      }
      expect(
        acquireUnmanagedWorkspaceMutationLease(harness.db, {
          environmentId: environment.id,
          requestId: "req-deleted-holder",
          threadId: holder.id,
        }),
      ).toMatchObject({ outcome: "acquired", generation: 1 });
      expect(
        acquireUnmanagedWorkspaceMutationLease(harness.db, {
          environmentId: environment.id,
          requestId: "req-deleted-waiter",
          threadId: waiter.id,
        }),
      ).toMatchObject({ outcome: "waiting" });
      markThreadDeleted(harness.db, harness.hub, { threadId: holder.id });

      expect(finalizeStoppedThread(harness.deps, { threadId: holder.id })).toBe(
        true,
      );

      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, waiter.id),
      ).toMatchObject({ generation: 2, requestId: "req-deleted-waiter" });
    });
  });

  it("retains a deleted runtime lease until the daemon confirms it stopped", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHostSession(harness.deps, {
        id: "host-workspace-active-holder-delete",
      }).host;
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/canonical/active-deleted-holder-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/canonical/active-deleted-holder-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const holder = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      const waiter = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        threadId: holder.id,
        turnId: "turn-active-deleted-holder",
      });
      for (const [id, threadId] of [
        ["req-active-deleted-holder", holder.id],
        ["req-active-deleted-waiter", waiter.id],
      ] as const) {
        createWorkAdmission(harness.db, {
          commandJson: "{}",
          hostId: host.id,
          id,
          reason: "interactive",
          threadId,
          waitingReason: "Awaiting host capacity",
        });
      }
      expect(
        acquireUnmanagedWorkspaceMutationLease(harness.db, {
          environmentId: environment.id,
          requestId: "req-active-deleted-holder",
          threadId: holder.id,
        }),
      ).toMatchObject({ outcome: "acquired", generation: 1 });
      expect(
        acquireUnmanagedWorkspaceMutationLease(harness.db, {
          environmentId: environment.id,
          requestId: "req-active-deleted-waiter",
          threadId: waiter.id,
        }),
      ).toMatchObject({ outcome: "waiting" });

      const response = await harness.app.request(
        `/api/v1/threads/${holder.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ childThreadsConfirmed: false }),
        },
      );
      expect(response.status).toBe(200);
      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === holder.id,
      );

      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, holder.id),
      ).toMatchObject({
        generation: 1,
        requestId: "req-active-deleted-holder",
      });
      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, waiter.id),
      ).toBeNull();
      expect(
        getUnmanagedWorkspaceMutationWaitState(
          harness.db,
          "req-active-deleted-waiter",
        ),
      ).toMatchObject({
        canonicalPath: "/canonical/active-deleted-holder-repo",
      });

      await reportQueuedCommandSuccess(harness, stopCommand, {
        providerCheckpointId: null,
      });

      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, holder.id),
      ).toBeNull();
      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, waiter.id),
      ).toMatchObject({
        generation: 2,
        requestId: "req-active-deleted-waiter",
      });
    });
  });

  it("preserves a promoted waiting lease during host reconciliation", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-promoted-reconcile",
      });
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/canonical/reconcile-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/canonical/reconcile-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const holder = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      const promoted = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      for (const [id, threadId] of [
        ["req-reconcile-holder", holder.id],
        ["req-reconcile-promoted", promoted.id],
      ] as const) {
        createWorkAdmission(harness.db, {
          commandJson: "{}",
          hostId: host.id,
          id,
          reason: "interactive",
          threadId,
          waitingReason: "Awaiting host capacity",
        });
      }
      expect(
        acquireUnmanagedWorkspaceMutationLeaseAndStartAdmission(harness.db, {
          environmentId: environment.id,
          requestId: "req-reconcile-holder",
          reservationGeneration: 1,
          reservationToken: "missing-host-reservation",
          threadId: holder.id,
        }),
      ).toMatchObject({ outcome: "acquired" });
      expect(
        acquireUnmanagedWorkspaceMutationLease(harness.db, {
          environmentId: environment.id,
          requestId: "req-reconcile-promoted",
          threadId: promoted.id,
        }),
      ).toMatchObject({ outcome: "waiting" });

      await reconcileHostWorkAdmissions(harness.deps, { hostId: host.id });

      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, promoted.id),
      ).toMatchObject({
        generation: 2,
        requestId: "req-reconcile-promoted",
      });
      expect(
        getWorkAdmission(harness.db, "req-reconcile-promoted"),
      ).toMatchObject({ status: "waiting" });
    });
  });

  it("does not duplicate a live workspace waiter during reconnect recovery", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-live-waiter-recovery",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/canonical/live-waiter-recovery-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/canonical/live-waiter-recovery-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const holder = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const waiter = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput: {
          "/canonical/live-waiter-recovery-repo":
            "/canonical/live-waiter-recovery-repo",
        },
        deferAdmissionReserveForThreadIds: new Set([waiter.id]),
        hostId: host.id,
        sessionId: session.id,
      });
      expect(
        acquireUnmanagedWorkspaceMutationLease(harness.db, {
          environmentId: environment.id,
          requestId: "req-live-waiter-recovery-holder",
          threadId: holder.id,
        }),
      ).toMatchObject({ outcome: "acquired" });

      const command = await buildThreadStartCommand(harness.deps, {
        environment,
        execution: {
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        fork: null,
        input: textInput("recover without duplicating this waiter"),
        permissionEscalation: "ask",
        projectId: project.id,
        providerId: waiter.providerId,
        requestId: encodeClientTurnRequestIdNumber({ value: 401 }),
        syncGeneratedTitle: false,
        thread: waiter,
      });
      void runLiveHostCommand(harness.deps, {
        admissionReason: "interactive",
        command,
        hostId: host.id,
        timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
      }).catch(() => {});
      const initialReservation = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "host.admission.reserve" &&
          queued.command.threadId === waiter.id,
      );
      if (initialReservation.command.type !== "host.admission.reserve") {
        throw new Error("Expected initial deferred admission reservation");
      }
      await reportQueuedCommandSuccess(harness, initialReservation, {
        outcome: "reserved",
        reservation: {
          generation: 1,
          hostId: host.id,
          reason: initialReservation.command.reason,
          token: `test-admission:${waiter.id}`,
        },
      });
      const admission = getCurrentThreadWorkAdmission(harness.db, waiter.id);
      if (!admission) throw new Error("Expected waiting admission");
      await vi.waitFor(() => {
        expect(
          getUnmanagedWorkspaceMutationWaitState(harness.db, admission.id),
        ).toMatchObject({
          canonicalPath: "/canonical/live-waiter-recovery-repo",
        });
      });

      recoverDurableWorkAdmissions(harness.deps, { hostId: host.id });
      harness.db.transaction((tx) =>
        releaseWorkspaceLeaseForThreadInTransaction(
          { db: tx },
          {
            reason: "promote live waiter during recovery",
            threadId: holder.id,
          },
        ),
      );
      await vi.waitFor(() => {
        expect(
          listQueuedCommands(harness, "host.admission.reserve").filter(
            (command) =>
              command.type === "host.admission.reserve" &&
              command.threadId === waiter.id,
          ),
        ).toHaveLength(1);
      });

      const promotedReservation = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "host.admission.reserve" &&
          queued.command.threadId === waiter.id,
      );
      if (promotedReservation.command.type !== "host.admission.reserve") {
        throw new Error("Expected promoted deferred admission reservation");
      }
      await reportQueuedCommandSuccess(harness, promotedReservation, {
        outcome: "reserved",
        reservation: {
          generation: 1,
          hostId: host.id,
          reason: promotedReservation.command.reason,
          token: `test-admission:${waiter.id}`,
        },
      });
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === waiter.id,
      );
      await releaseThreadWorkAdmission(harness.deps, {
        terminalReason: "test live waiter recovery completed",
        threadId: waiter.id,
      });
    });
  });

  it("cleans durable workspace state after canonicalization failure", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-canonicalization-failure",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/legacy/missing-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const missingEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/legacy/missing-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const failed = seedThread(harness.deps, {
        environmentId: missingEnvironment.id,
        projectId: project.id,
        status: "idle",
      });
      const workspaceHolder = seedThread(harness.deps, {
        environmentId: missingEnvironment.id,
        projectId: project.id,
        status: "idle",
      });
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput: {
          "/legacy/missing-repo": "/legacy/missing-repo",
        },
        deferProjectInspectForPaths: new Set(["/legacy/missing-repo"]),
        hostId: host.id,
        sessionId: session.id,
      });
      const payload = (text: string) => ({
        input: textInput(text),
        mode: "start" as const,
        model: "gpt-5",
        permissionMode: "full" as const,
        reasoningLevel: "medium" as const,
        serviceTier: "default" as const,
      });
      createWorkAdmission(harness.db, {
        commandJson: "{}",
        hostId: host.id,
        id: "req-canonicalization-holder",
        reason: "interactive",
        threadId: workspaceHolder.id,
        waitingReason: "Awaiting host capacity",
      });
      expect(
        acquireUnmanagedWorkspaceMutationLease(harness.db, {
          environmentId: missingEnvironment.id,
          requestId: "req-canonicalization-holder",
          threadId: workspaceHolder.id,
        }),
      ).toMatchObject({ outcome: "acquired", generation: 1 });

      await sendThreadMessage(harness.deps, {
        environment: missingEnvironment,
        payload: payload("missing legacy path"),
        thread: failed,
        trigger: "user",
      });
      const inspection = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "project.inspect" &&
          queued.command.path === "/legacy/missing-repo",
      );
      const failedAdmission = getCurrentThreadWorkAdmission(
        harness.db,
        failed.id,
      );
      expect(failedAdmission).toMatchObject({ status: "waiting" });
      expect(
        acquireUnmanagedWorkspaceMutationLease(harness.db, {
          environmentId: missingEnvironment.id,
          requestId: failedAdmission!.id,
          threadId: failed.id,
        }),
      ).toMatchObject({ outcome: "waiting" });

      await reportQueuedCommandError(harness, inspection, {
        errorCode: "ENOENT",
        errorMessage: "Workspace path does not exist",
      });
      expect(getWorkAdmission(harness.db, failedAdmission!.id)).toMatchObject({
        status: "terminal",
        terminalReason: expect.stringContaining("canonicalization failed"),
      });
      expect(
        getUnmanagedWorkspaceMutationWaitState(harness.db, failedAdmission!.id),
      ).toBeNull();
      const holderLease = getUnmanagedWorkspaceMutationLease(
        harness.db,
        host.id,
        "/legacy/missing-repo",
      );
      expect(holderLease).toMatchObject({ generation: 1 });
      expect(
        releaseUnmanagedWorkspaceMutationLease(harness.db, {
          canonicalPath: "/legacy/missing-repo",
          generation: holderLease!.generation,
          hostId: host.id,
          reason: "test holder finished",
        }),
      ).toEqual({ promoted: null, released: true });
    });
  });

  it("recanonicalizes queued aliases before acquiring workspace leases after reconnect", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-reconnect-aliases",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/legacy/reconnect-repo-a",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const firstEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/legacy/reconnect-repo-a",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const secondEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/legacy/reconnect-repo-b",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const first = seedThread(harness.deps, {
        environmentId: firstEnvironment.id,
        projectId: project.id,
        status: "idle",
      });
      const second = seedThread(harness.deps, {
        environmentId: secondEnvironment.id,
        projectId: project.id,
        status: "idle",
      });
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput: {
          "/legacy/reconnect-repo-a": "/canonical/reconnect-repo",
          "/legacy/reconnect-repo-b": "/canonical/reconnect-repo",
        },
        deferAdmissionReserveForThreadIds: new Set([first.id]),
        hostId: host.id,
        sessionId: session.id,
      });
      const payload = (text: string) => ({
        input: textInput(text),
        mode: "start" as const,
        model: "gpt-5",
        permissionMode: "full" as const,
        reasoningLevel: "medium" as const,
        serviceTier: "default" as const,
      });

      await sendThreadMessage(harness.deps, {
        environment: firstEnvironment,
        payload: payload("first reconnect mutation"),
        thread: first,
        trigger: "user",
      });
      await sendThreadMessage(harness.deps, {
        environment: secondEnvironment,
        payload: payload("second reconnect mutation"),
        thread: second,
        trigger: "user",
      });
      const firstReserve = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "host.admission.reserve" &&
          queued.command.threadId === first.id,
      );
      if (firstReserve.command.type !== "host.admission.reserve") {
        throw new Error("Expected deferred admission reservation");
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      clearEnvironmentPathCanonicalizationsForHost(harness.db, host.id);
      await reportQueuedCommandSuccess(harness, firstReserve, {
        outcome: "reserved",
        reservation: {
          generation: 1,
          hostId: host.id,
          reason: firstReserve.command.reason,
          token: `test-admission:${first.id}`,
        },
      });
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === first.id,
      );

      await vi.waitFor(() => {
        expect(
          getCurrentThreadWorkAdmission(harness.db, second.id),
        ).toMatchObject({
          status: "waiting",
          waitingReason: expect.stringContaining("owns unmanaged workspace"),
        });
      });
      expect(
        listQueuedThreadCommands(harness, "thread.start", second.id),
      ).toHaveLength(0);
      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, first.id),
      ).toMatchObject({ canonicalPath: "/canonical/reconnect-repo" });
      expect(
        getUnmanagedWorkspaceMutationWaitState(
          harness.db,
          getCurrentThreadWorkAdmission(harness.db, second.id)!.id,
        ),
      ).toMatchObject({ canonicalPath: "/canonical/reconnect-repo" });

      await releaseThreadWorkAdmission(harness.deps, {
        terminalReason: "test reconnect waiter cancelled",
        threadId: second.id,
      });
      await releaseThreadWorkAdmission(harness.deps, {
        terminalReason: "test reconnect holder completed",
        threadId: first.id,
      });
    });
  });

  it("preserves an in-flight waiting reservation during reconnect reconciliation", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-reconnect-reconcile",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/legacy/reconnect-reconcile-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/legacy/reconnect-reconcile-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const deferredInspects = new Set<string>();
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput: {
          "/legacy/reconnect-reconcile-repo":
            "/canonical/reconnect-reconcile-repo",
        },
        deferAdmissionReserveForThreadIds: new Set([thread.id]),
        deferProjectInspectForPaths: deferredInspects,
        hostId: host.id,
        sessionId: session.id,
      });

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: textInput("reconcile while re-gating"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread,
        trigger: "user",
      });
      const reservation = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "host.admission.reserve" &&
          queued.command.threadId === thread.id,
      );
      if (reservation.command.type !== "host.admission.reserve") {
        throw new Error("Expected deferred admission reservation");
      }
      deferredInspects.add("/legacy/reconnect-reconcile-repo");
      clearEnvironmentPathCanonicalizationsForHost(harness.db, host.id);
      await reportQueuedCommandSuccess(harness, reservation, {
        outcome: "reserved",
        reservation: {
          generation: 1,
          hostId: host.id,
          reason: reservation.command.reason,
          token: `test-admission:${thread.id}`,
        },
      });
      const inspection = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "project.inspect" &&
          queued.command.path === "/legacy/reconnect-reconcile-repo",
      );

      await reconcileHostWorkAdmissions(harness.deps, { hostId: host.id });
      if (inspection.command.type !== "project.inspect") {
        throw new Error("Expected deferred project inspection");
      }
      await reportQueuedCommandSuccess(harness, inspection, {
        path: "/canonical/reconnect-reconcile-repo",
        gitRemoteUrl: null,
      });
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === thread.id,
      );
      await reconcileHostWorkAdmissions(harness.deps, { hostId: host.id });
      expect(
        getCurrentThreadWorkAdmission(harness.db, thread.id),
      ).toMatchObject({ status: "running" });
      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, thread.id),
      ).toMatchObject({
        canonicalPath: "/canonical/reconnect-reconcile-repo",
      });
      await releaseThreadWorkAdmission(harness.deps, {
        terminalReason: "test reconnect reconciliation completed",
        threadId: thread.id,
      });
    });
  });

  it("refreshes the queued workspace command when its canonical target changes", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-reconnect-command",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/legacy/reconnect-command-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/legacy/reconnect-command-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const canonicalPathByInput: Record<string, string> = {
        "/legacy/reconnect-command-repo": "/canonical/reconnect-command-v1",
      };
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput,
        deferAdmissionReserveForThreadIds: new Set([thread.id]),
        hostId: host.id,
        sessionId: session.id,
      });

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: textInput("dispatch at the refreshed target"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread,
        trigger: "user",
      });
      const reservation = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "host.admission.reserve" &&
          queued.command.threadId === thread.id,
      );
      if (reservation.command.type !== "host.admission.reserve") {
        throw new Error("Expected deferred admission reservation");
      }
      canonicalPathByInput["/legacy/reconnect-command-repo"] =
        "/canonical/reconnect-command-v2";
      clearEnvironmentPathCanonicalizationsForHost(harness.db, host.id);
      await reportQueuedCommandSuccess(harness, reservation, {
        outcome: "reserved",
        reservation: {
          generation: 1,
          hostId: host.id,
          reason: reservation.command.reason,
          token: `test-admission:${thread.id}`,
        },
      });
      const start = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === thread.id,
      );
      if (start.command.type !== "thread.start") {
        throw new Error("Expected thread start command");
      }

      expect(start.command.workspaceContext.workspacePath).toBe(
        "/canonical/reconnect-command-v2",
      );
      const admission = getCurrentThreadWorkAdmission(harness.db, thread.id);
      expect(admission).toMatchObject({ status: "running" });
      expect(
        JSON.parse(admission!.commandJson).workspaceContext.workspacePath,
      ).toBe("/canonical/reconnect-command-v2");
      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, thread.id),
      ).toMatchObject({ canonicalPath: "/canonical/reconnect-command-v2" });

      await releaseThreadWorkAdmission(harness.deps, {
        terminalReason: "test refreshed command completed",
        threadId: thread.id,
      });
    });
  });

  it("rekeys a promoted waiting lease when its canonical target changes", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-promoted-retarget",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/legacy/promoted-retarget-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/legacy/promoted-retarget-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const holder = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const waiter = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const canonicalPathByInput: Record<string, string> = {
        "/legacy/promoted-retarget-repo":
          "/canonical/promoted-retarget-v1",
      };
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput,
        deferAdmissionReserveForThreadIds: new Set([waiter.id]),
        hostId: host.id,
        sessionId: session.id,
      });
      recordEnvironmentCanonicalPath(
        harness.db,
        harness.hub,
        environment.id,
        "/canonical/promoted-retarget-v1",
      );
      expect(
        acquireUnmanagedWorkspaceMutationLease(harness.db, {
          environmentId: environment.id,
          requestId: "req-promoted-retarget-holder",
          threadId: holder.id,
        }),
      ).toMatchObject({
        canonicalPath: "/canonical/promoted-retarget-v1",
        outcome: "acquired",
      });

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: textInput("dispatch after the promoted path retargets"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread: waiter,
        trigger: "user",
      });
      const firstReservation = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "host.admission.reserve" &&
          queued.command.threadId === waiter.id,
      );
      if (firstReservation.command.type !== "host.admission.reserve") {
        throw new Error("Expected first deferred admission reservation");
      }
      await reportQueuedCommandSuccess(harness, firstReservation, {
        outcome: "reserved",
        reservation: {
          generation: 1,
          hostId: host.id,
          reason: firstReservation.command.reason,
          token: `test-admission:${waiter.id}`,
        },
      });
      const waitingAdmission = getCurrentThreadWorkAdmission(
        harness.db,
        waiter.id,
      );
      if (!waitingAdmission) throw new Error("Expected waiting admission");
      await vi.waitFor(() => {
        expect(
          getUnmanagedWorkspaceMutationWaitState(
            harness.db,
            waitingAdmission.id,
          ),
        ).toMatchObject({
          canonicalPath: "/canonical/promoted-retarget-v1",
        });
      });

      harness.db.transaction((tx) =>
        releaseWorkspaceLeaseForThreadInTransaction(
          { db: tx },
          {
            reason: "promote retargeted waiter",
            threadId: holder.id,
          },
        ),
      );
      await vi.waitFor(() => {
        expect(
          getUnmanagedWorkspaceMutationLeaseForThread(harness.db, waiter.id),
        ).toMatchObject({
          canonicalPath: "/canonical/promoted-retarget-v1",
          requestId: waitingAdmission.id,
        });
      });
      const secondReservation = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "host.admission.reserve" &&
          queued.command.threadId === waiter.id,
      );
      if (secondReservation.command.type !== "host.admission.reserve") {
        throw new Error("Expected second deferred admission reservation");
      }
      canonicalPathByInput["/legacy/promoted-retarget-repo"] =
        "/canonical/promoted-retarget-v2";
      clearEnvironmentPathCanonicalizationsForHost(harness.db, host.id);
      await reportQueuedCommandSuccess(harness, secondReservation, {
        outcome: "reserved",
        reservation: {
          generation: 1,
          hostId: host.id,
          reason: secondReservation.command.reason,
          token: `test-admission:${waiter.id}`,
        },
      });
      const start = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === waiter.id,
      );
      if (start.command.type !== "thread.start") {
        throw new Error("Expected thread start command");
      }

      expect(start.command.workspaceContext.workspacePath).toBe(
        "/canonical/promoted-retarget-v2",
      );
      expect(
        getUnmanagedWorkspaceMutationLease(
          harness.db,
          host.id,
          "/canonical/promoted-retarget-v1",
        ),
      ).toBeNull();
      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, waiter.id),
      ).toMatchObject({
        canonicalPath: "/canonical/promoted-retarget-v2",
        requestId: waitingAdmission.id,
      });

      await releaseThreadWorkAdmission(harness.deps, {
        terminalReason: "test promoted retarget completed",
        threadId: waiter.id,
      });
    });
  });

  it("refreshes a queued turn submission when its canonical target changes", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-reconnect-turn-command",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/legacy/reconnect-turn-command-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/legacy/reconnect-turn-command-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-reconnect-turn-command",
        threadId: thread.id,
        turnId: "turn-reconnect-turn-command",
      });
      const activeThread = getThread(harness.db, thread.id);
      if (!activeThread) throw new Error("Expected active thread");
      const canonicalPathByInput: Record<string, string> = {
        "/legacy/reconnect-turn-command-repo":
          "/canonical/reconnect-turn-command-v1",
      };
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput,
        deferAdmissionReserveForThreadIds: new Set([thread.id]),
        hostId: host.id,
        sessionId: session.id,
      });

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: textInput("steer at the refreshed target"),
          mode: "steer",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread: activeThread,
        trigger: "user",
      });
      const reservation = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "host.admission.reserve" &&
          queued.command.threadId === thread.id,
      );
      if (reservation.command.type !== "host.admission.reserve") {
        throw new Error("Expected deferred admission reservation");
      }
      canonicalPathByInput["/legacy/reconnect-turn-command-repo"] =
        "/canonical/reconnect-turn-command-v2";
      clearEnvironmentPathCanonicalizationsForHost(harness.db, host.id);
      await reportQueuedCommandSuccess(harness, reservation, {
        outcome: "reserved",
        reservation: {
          generation: 1,
          hostId: host.id,
          reason: reservation.command.reason,
          token: `test-admission:${thread.id}`,
        },
      });
      const submit = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "turn.submit" &&
          queued.command.threadId === thread.id,
      );
      if (submit.command.type !== "turn.submit") {
        throw new Error("Expected turn submit command");
      }

      expect(
        submit.command.resumeContext.workspaceContext.workspacePath,
      ).toBe("/canonical/reconnect-turn-command-v2");
      const admission = getCurrentThreadWorkAdmission(harness.db, thread.id);
      expect(admission).toMatchObject({ status: "running" });
      expect(
        JSON.parse(admission!.commandJson).resumeContext.workspaceContext
          .workspacePath,
      ).toBe("/canonical/reconnect-turn-command-v2");
      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, thread.id),
      ).toMatchObject({
        canonicalPath: "/canonical/reconnect-turn-command-v2",
      });

      await releaseThreadWorkAdmission(harness.deps, {
        terminalReason: "test refreshed turn command completed",
        threadId: thread.id,
      });
    });
  });

  it("keeps a warm submission on its resident lease after a symlink retarget", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-resident-turn-command",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/legacy/resident-turn-command-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/legacy/resident-turn-command-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-resident-turn-command",
        threadId: thread.id,
        turnId: "turn-resident-turn-command",
      });
      const activeThread = getThread(harness.db, thread.id);
      if (!activeThread) throw new Error("Expected active thread");
      recordEnvironmentCanonicalPath(
        harness.db,
        harness.hub,
        environment.id,
        "/canonical/resident-turn-command-v1",
      );
      createWorkAdmission(harness.db, {
        commandJson: "{}",
        hostId: host.id,
        id: "req-resident-turn-command",
        reason: "interactive",
        threadId: thread.id,
        waitingReason: "Awaiting host capacity",
      });
      expect(
        acquireUnmanagedWorkspaceMutationLeaseAndStartAdmission(harness.db, {
          environmentId: environment.id,
          requestId: "req-resident-turn-command",
          reservationGeneration: 1,
          reservationToken: `test-admission:${thread.id}`,
          threadId: thread.id,
        }),
      ).toMatchObject({
        canonicalPath: "/canonical/resident-turn-command-v1",
        outcome: "acquired",
      });
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput: {
          "/legacy/resident-turn-command-repo":
            "/canonical/resident-turn-command-v2",
        },
        hostId: host.id,
        sessionId: session.id,
      });
      clearEnvironmentPathCanonicalizationsForHost(harness.db, host.id);

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: textInput("steer the resident runtime"),
          mode: "steer",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread: activeThread,
        trigger: "user",
      });
      const submit = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "turn.submit" &&
          queued.command.threadId === thread.id,
      );
      if (submit.command.type !== "turn.submit") {
        throw new Error("Expected turn submit command");
      }

      expect(
        submit.command.resumeContext.workspaceContext.workspacePath,
      ).toBe("/canonical/resident-turn-command-v1");
      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, thread.id),
      ).toMatchObject({
        canonicalPath: "/canonical/resident-turn-command-v1",
        requestId: "req-resident-turn-command",
      });

      await releaseThreadWorkAdmission(harness.deps, {
        terminalReason: "test resident turn command completed",
        threadId: thread.id,
      });
    });
  });

  it("withholds a second provider command until the holder releases through the common admission seam", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-lease",
      });
      const deferredProjectInspects = new Set<string>();
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput: {
          "/canonical/shared-repo": "/canonical/shared-repo",
        },
        deferProjectInspectForPaths: deferredProjectInspects,
        hostId: host.id,
        sessionId: session.id,
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/canonical/shared-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/canonical/shared-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const first = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const second = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const payload = (text: string) => ({
        input: textInput(text),
        mode: "start" as const,
        model: "gpt-5",
        permissionMode: "full" as const,
        reasoningLevel: "medium" as const,
        serviceTier: "default" as const,
      });

      await sendThreadMessage(harness.deps, {
        environment,
        payload: payload("first mutation"),
        thread: first,
        trigger: "user",
      });
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === first.id,
      );
      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, first.id),
      ).toMatchObject({ canonicalPath: "/canonical/shared-repo" });
      // A second admission must use the durable per-environment confirmation.
      // If it tries to inspect this path again, the deferred RPC below will
      // strand it before it reaches the workspace waiter assertion.
      deferredProjectInspects.add("/canonical/shared-repo");

      await sendThreadMessage(harness.deps, {
        environment,
        payload: payload("second mutation"),
        thread: second,
        trigger: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        listQueuedThreadCommands(harness, "thread.start", second.id),
      ).toHaveLength(0);
      expect(
        getCurrentThreadWorkAdmission(harness.db, second.id),
      ).toMatchObject({
        status: "waiting",
        waitingReason: expect.stringContaining("owns unmanaged workspace"),
      });
      expect(listQueuedCommands(harness, "project.inspect")).toHaveLength(0);

      await releaseThreadWorkAdmission(harness.deps, {
        terminalReason: "test holder completed",
        threadId: first.id,
      });
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === second.id,
      );
      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, second.id),
      ).toMatchObject({ canonicalPath: "/canonical/shared-repo" });
    });
  });

  it("cancels a workspace waiter without leaving its admission loop stranded", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-cancel",
      });
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput: {
          "/canonical/cancel-repo": "/canonical/cancel-repo",
        },
        hostId: host.id,
        sessionId: session.id,
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/canonical/cancel-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/canonical/cancel-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const first = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const second = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const payload = (text: string) => ({
        input: textInput(text),
        mode: "start" as const,
        model: "gpt-5",
        permissionMode: "full" as const,
        reasoningLevel: "medium" as const,
        serviceTier: "default" as const,
      });

      await sendThreadMessage(harness.deps, {
        environment,
        payload: payload("holder mutation"),
        thread: first,
        trigger: "user",
      });
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === first.id,
      );
      await sendThreadMessage(harness.deps, {
        environment,
        payload: payload("cancelled mutation"),
        thread: second,
        trigger: "user",
      });
      await vi.waitFor(() => {
        expect(
          getCurrentThreadWorkAdmission(harness.db, second.id),
        ).toMatchObject({
          status: "waiting",
          waitingReason: expect.stringContaining("owns unmanaged workspace"),
        });
      });

      await expect(
        releaseThreadWorkAdmission(harness.deps, {
          terminalReason: "test waiter cancelled",
          threadId: second.id,
        }),
      ).resolves.toBe(true);
      await releaseThreadWorkAdmission(harness.deps, {
        terminalReason: "test holder completed",
        threadId: first.id,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(
        listQueuedThreadCommands(harness, "thread.start", second.id),
      ).toHaveLength(0);
      expect(getCurrentThreadWorkAdmission(harness.db, second.id)).toBeNull();
    });
  });

  it("lets unrelated work bypass a workspace-blocked FIFO head", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-independent",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/canonical/blocked-repo",
      });
      updateProject(harness.db, harness.hub, project.id, {
        protectUnmanagedWorkspace: true,
      });
      const blockedEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/canonical/blocked-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const independentEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/canonical/independent-repo",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const holder = seedThread(harness.deps, {
        environmentId: blockedEnvironment.id,
        projectId: project.id,
        status: "idle",
      });
      const blocked = seedThread(harness.deps, {
        environmentId: blockedEnvironment.id,
        projectId: project.id,
        status: "idle",
      });
      const independent = seedThread(harness.deps, {
        environmentId: independentEnvironment.id,
        projectId: project.id,
        status: "idle",
      });
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput: {
          "/canonical/blocked-repo": "/canonical/blocked-repo",
          "/canonical/independent-repo": "/canonical/independent-repo",
        },
        deferAdmissionReserveForThreadIds: new Set([blocked.id]),
        hostId: host.id,
        sessionId: session.id,
      });
      const payload = (text: string) => ({
        input: textInput(text),
        mode: "start" as const,
        model: "gpt-5",
        permissionMode: "full" as const,
        reasoningLevel: "medium" as const,
        serviceTier: "default" as const,
      });

      await sendThreadMessage(harness.deps, {
        environment: blockedEnvironment,
        payload: payload("hold blocked path"),
        thread: holder,
        trigger: "user",
      });
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === holder.id,
      );
      await sendThreadMessage(harness.deps, {
        environment: blockedEnvironment,
        payload: payload("wait behind holder"),
        thread: blocked,
        trigger: "user",
      });
      const blockedReserve = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "host.admission.reserve" &&
          queued.command.threadId === blocked.id,
      );
      if (blockedReserve.command.type !== "host.admission.reserve") {
        throw new Error("Expected deferred admission reservation");
      }

      await sendThreadMessage(harness.deps, {
        environment: independentEnvironment,
        payload: payload("run on independent path"),
        thread: independent,
        trigger: "user",
      });
      await vi.waitFor(() => {
        expect(
          getCurrentThreadWorkAdmission(harness.db, independent.id),
        ).toMatchObject({ status: "waiting" });
        expect(
          listQueuedCommands(harness, "host.admission.reserve").filter(
            (command) =>
              command.type === "host.admission.reserve" &&
              command.threadId === independent.id,
          ),
        ).toHaveLength(0);
      });

      await reportQueuedCommandSuccess(harness, blockedReserve, {
        outcome: "reserved",
        reservation: {
          generation: 1,
          hostId: host.id,
          reason: blockedReserve.command.reason,
          token: `test-admission:${blocked.id}`,
        },
      });
      await vi.waitFor(() => {
        expect(
          getCurrentThreadWorkAdmission(harness.db, blocked.id),
        ).toMatchObject({ waitingReason: expect.stringContaining("owns") });
      });
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === independent.id,
      );
      expect(
        getCurrentThreadWorkAdmission(harness.db, independent.id),
      ).toMatchObject({ status: "running" });
      expect(
        listQueuedThreadCommands(harness, "thread.start", blocked.id),
      ).toHaveLength(0);
    });
  });

  it("canonicalizes legacy aliases before evaluating shared protection", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-legacy-alias",
      });
      const protectedProject = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/legacy/shared-alias-a",
      }).project;
      updateProject(harness.db, harness.hub, protectedProject.id, {
        protectUnmanagedWorkspace: true,
      });
      const protectedEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/legacy/shared-alias-a",
        projectId: protectedProject.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      const aliasEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/legacy/shared-alias-b",
        projectId: protectedProject.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput: {
          "/legacy/shared-alias-a": "/canonical/shared-legacy-repo",
          "/legacy/shared-alias-b": "/canonical/shared-legacy-repo",
        },
        deferProjectInspectForPaths: new Set(["/legacy/shared-alias-a"]),
        hostId: host.id,
        sessionId: session.id,
      });
      const holder = seedThread(harness.deps, {
        environmentId: protectedEnvironment.id,
        projectId: protectedProject.id,
        status: "idle",
      });
      const alias = seedThread(harness.deps, {
        environmentId: aliasEnvironment.id,
        projectId: protectedProject.id,
        status: "idle",
      });
      const payload = (text: string) => ({
        input: textInput(text),
        mode: "start" as const,
        model: "gpt-5",
        permissionMode: "full" as const,
        reasoningLevel: "medium" as const,
        serviceTier: "default" as const,
      });

      await sendThreadMessage(harness.deps, {
        environment: protectedEnvironment,
        payload: payload("canonical holder"),
        thread: holder,
        trigger: "user",
      });
      const pendingCanonicalization = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "project.inspect" &&
          queued.command.path === "/legacy/shared-alias-a",
      );
      expect(
        getCurrentThreadWorkAdmission(harness.db, holder.id),
      ).toMatchObject({ status: "waiting" });
      if (pendingCanonicalization.command.type !== "project.inspect") {
        throw new Error("Expected deferred project inspection");
      }
      await reportQueuedCommandSuccess(harness, pendingCanonicalization, {
        path: "/canonical/shared-legacy-repo",
        gitRemoteUrl: null,
      });
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === holder.id,
      );
      expect(getEnvironment(harness.db, protectedEnvironment.id)?.path).toBe(
        "/legacy/shared-alias-a",
      );
      expect(getEnvironment(harness.db, aliasEnvironment.id)?.path).toBe(
        "/legacy/shared-alias-b",
      );
      expect(
        getUnmanagedWorkspaceMutationLeaseForThread(harness.db, holder.id),
      ).toMatchObject({ canonicalPath: "/canonical/shared-legacy-repo" });

      await sendThreadMessage(harness.deps, {
        environment: aliasEnvironment,
        payload: payload("legacy alias waiter"),
        thread: alias,
        trigger: "user",
      });
      await vi.waitFor(() => {
        expect(
          getCurrentThreadWorkAdmission(harness.db, alias.id),
        ).toMatchObject({ waitingReason: expect.stringContaining("owns") });
      });
      expect(
        listQueuedThreadCommands(harness, "thread.start", alias.id),
      ).toHaveLength(0);
    });
  });
});
