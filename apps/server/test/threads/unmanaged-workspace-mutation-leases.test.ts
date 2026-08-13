import {
  getEnvironment,
  getCurrentThreadWorkAdmission,
  getUnmanagedWorkspaceMutationLeaseForThread,
  updateProject,
} from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import { releaseThreadWorkAdmission } from "../../src/services/threads/work-admission.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import {
  listQueuedCommands,
  listQueuedThreadCommands,
  registerTestHostRpcCapture,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("protected unmanaged workspace dispatch", () => {
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
