import {
  getCurrentThreadWorkAdmission,
  getUnmanagedWorkspaceMutationLeaseForThread,
  updateProject,
} from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import { releaseThreadWorkAdmission } from "../../src/services/threads/work-admission.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import {
  listQueuedThreadCommands,
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
      const { host } = seedHostSession(harness.deps, {
        id: "host-workspace-lease",
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
      const { host } = seedHostSession(harness.deps, {
        id: "host-workspace-cancel",
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
});
