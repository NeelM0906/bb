import {
  acquireUnmanagedWorkspaceMutationLease,
  acquireUnmanagedWorkspaceMutationLeaseAndStartAdmission,
  createWorkAdmission,
  getEnvironment,
  getCurrentThreadWorkAdmission,
  getWorkAdmission,
  getUnmanagedWorkspaceMutationLease,
  getUnmanagedWorkspaceMutationLeaseForThread,
  getUnmanagedWorkspaceMutationWaitState,
  markThreadDeleted,
  releaseUnmanagedWorkspaceMutationLease,
  updateProject,
} from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import {
  listRecoverableWorkAdmissionCommands,
  reconcileHostWorkAdmissions,
  releaseThreadWorkAdmission,
} from "../../src/services/threads/work-admission.js";
import { finalizeStoppedThread } from "../../src/services/threads/thread-lifecycle.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
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

  it("withholds a second provider command until the holder releases through the common admission seam", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-workspace-lease",
      });
      registerTestHostRpcCapture(harness, {
        canonicalPathByInput: {
          "/canonical/shared-repo": "/canonical/shared-repo",
        },
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
      const aliasProject = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/legacy/shared-alias-b",
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
        projectId: aliasProject.id,
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
        projectId: aliasProject.id,
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
        "/canonical/shared-legacy-repo",
      );
      expect(getEnvironment(harness.db, aliasEnvironment.id)?.path).toBe(
        "/canonical/shared-legacy-repo",
      );

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
