import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { createEnvironment } from "../../src/data/environments.js";
import {
  acquireUnmanagedWorkspaceMutationLease,
  acquireUnmanagedWorkspaceMutationLeaseAndStartAdmission,
  cancelUnmanagedWorkspaceMutationWaiter,
  getUnmanagedWorkspaceMutationLease,
  isUnmanagedWorkspaceMutationProtected,
  listUnmanagedWorkspaceMutationLeaseEvents,
  releaseUnmanagedWorkspaceMutationLease,
} from "../../src/data/unmanaged-workspace-mutation-leases.js";
import { upsertHost } from "../../src/data/hosts.js";
import {
  createProject,
  getProject,
  ProjectUnmanagedWorkspaceProtectionConflictError,
  updateProject,
} from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import {
  createWorkAdmission,
  markWorkAdmissionRunning,
} from "../../src/data/work-admissions.js";
import { getWorkAdmission } from "../../src/data/work-admissions.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "lease-host",
    type: "persistent",
  });
  const firstProject = createProject(db, noopNotifier, {
    name: "protected-project",
    source: { type: "local_path", hostId: host.id, path: "/repo" },
  }).project;
  const secondProject = createProject(db, noopNotifier, {
    name: "shared-project",
    source: { type: "local_path", hostId: host.id, path: "/repo" },
  }).project;
  updateProject(db, noopNotifier, firstProject.id, {
    protectUnmanagedWorkspace: true,
  });
  const firstEnvironment = createEnvironment(db, noopNotifier, {
    hostId: host.id,
    path: "/canonical/repo",
    projectId: firstProject.id,
    status: "ready",
    workspaceProvisionType: "unmanaged",
  });
  const secondEnvironment = createEnvironment(db, noopNotifier, {
    hostId: host.id,
    path: "/canonical/repo",
    projectId: secondProject.id,
    status: "ready",
    workspaceProvisionType: "unmanaged",
  });
  const firstThread = createThread(db, noopNotifier, {
    environmentId: firstEnvironment.id,
    projectId: firstProject.id,
    providerId: "codex",
  });
  const secondThread = createThread(db, noopNotifier, {
    environmentId: secondEnvironment.id,
    projectId: secondProject.id,
    providerId: "codex",
  });
  for (const [requestId, threadId] of [
    ["req-first", firstThread.id],
    ["req-second", secondThread.id],
  ] as const) {
    createWorkAdmission(db, {
      commandJson: "{}",
      createdAt: requestId === "req-first" ? 10 : 20,
      hostId: host.id,
      id: requestId,
      reason: "interactive",
      threadId,
      waitingReason: "Awaiting host capacity",
    });
  }
  return {
    db,
    firstEnvironment,
    firstProject,
    firstThread,
    host,
    secondEnvironment,
    secondProject,
    secondThread,
  };
}

describe("unmanaged workspace mutation leases", () => {
  it("rejects enabling protection while unmanaged work is already running", () => {
    const db = createConnection(":memory:");
    migrate(db);
    const host = upsertHost(db, noopNotifier, {
      name: "transition-host",
      type: "persistent",
    });
    const project = createProject(db, noopNotifier, {
      name: "transition-project",
      source: { type: "local_path", hostId: host.id, path: "/transition" },
    }).project;
    const environment = createEnvironment(db, noopNotifier, {
      hostId: host.id,
      path: "/transition",
      projectId: project.id,
      status: "ready",
      workspaceProvisionType: "unmanaged",
    });
    const thread = createThread(db, noopNotifier, {
      environmentId: environment.id,
      projectId: project.id,
      providerId: "codex",
    });
    createWorkAdmission(db, {
      commandJson: "{}",
      hostId: host.id,
      id: "req-transition",
      reason: "interactive",
      threadId: thread.id,
      waitingReason: "Awaiting host capacity",
    });
    markWorkAdmissionRunning(db, {
      id: "req-transition",
      reservationGeneration: 1,
      reservationToken: "transition-token",
    });

    expect(() =>
      updateProject(db, noopNotifier, project.id, {
        protectUnmanagedWorkspace: true,
      }),
    ).toThrow(ProjectUnmanagedWorkspaceProtectionConflictError);
    expect(getProject(db, project.id)?.protectUnmanagedWorkspace).toBe(false);
  });

  it("atomically acquires workspace ownership and starts the durable admission", () => {
    const { db, firstEnvironment, firstThread, host } = setup();

    expect(
      acquireUnmanagedWorkspaceMutationLeaseAndStartAdmission(db, {
        environmentId: firstEnvironment.id,
        requestId: "req-first",
        reservationGeneration: 7,
        reservationToken: "reservation-seven",
        threadId: firstThread.id,
      }),
    ).toMatchObject({ outcome: "acquired", generation: 1 });
    expect(getWorkAdmission(db, "req-first")).toMatchObject({
      reservationGeneration: 7,
      reservationToken: "reservation-seven",
      status: "running",
      waitingReason: null,
    });
    expect(getUnmanagedWorkspaceMutationLease(db, host.id, "/canonical/repo"))
      .toMatchObject({ requestId: "req-first", generation: 1 });
  });

  it("enables physical-path protection across projects when either project opts in", () => {
    const { db, firstEnvironment, secondEnvironment, secondProject } = setup();

    expect(
      isUnmanagedWorkspaceMutationProtected(db, firstEnvironment.id),
    ).toBe(true);
    expect(
      isUnmanagedWorkspaceMutationProtected(db, secondEnvironment.id),
    ).toBe(true);

    updateProject(db, noopNotifier, secondProject.id, {
      protectUnmanagedWorkspace: false,
    });
    expect(
      isUnmanagedWorkspaceMutationProtected(db, secondEnvironment.id),
    ).toBe(true);
  });

  it("acquires once, queues FIFO, generation-checks release, and atomically promotes one waiter", () => {
    const {
      db,
      firstEnvironment,
      firstThread,
      host,
      secondEnvironment,
      secondThread,
    } = setup();

    const acquired = acquireUnmanagedWorkspaceMutationLease(db, {
      environmentId: firstEnvironment.id,
      requestId: "req-first",
      threadId: firstThread.id,
    });
    expect(acquired).toMatchObject({ outcome: "acquired", generation: 1 });

    const waiting = acquireUnmanagedWorkspaceMutationLease(db, {
      environmentId: secondEnvironment.id,
      requestId: "req-second",
      threadId: secondThread.id,
    });
    expect(waiting).toMatchObject({
      outcome: "waiting",
      holder: {
        requestId: "req-first",
        threadId: firstThread.id,
      },
    });

    expect(
      releaseUnmanagedWorkspaceMutationLease(db, {
        generation: 999,
        hostId: host.id,
        canonicalPath: "/canonical/repo",
        reason: "stale completion",
      }),
    ).toEqual({ released: false, promoted: null });
    expect(getUnmanagedWorkspaceMutationLease(db, host.id, "/canonical/repo"))
      .toMatchObject({ requestId: "req-first", generation: 1 });

    expect(
      releaseUnmanagedWorkspaceMutationLease(db, {
        generation: 1,
        hostId: host.id,
        canonicalPath: "/canonical/repo",
        reason: "turn completed",
      }),
    ).toMatchObject({
      released: true,
      promoted: {
        requestId: "req-second",
        threadId: secondThread.id,
        generation: 2,
      },
    });
    expect(getUnmanagedWorkspaceMutationLease(db, host.id, "/canonical/repo"))
      .toMatchObject({ requestId: "req-second", generation: 2 });

    expect(
      listUnmanagedWorkspaceMutationLeaseEvents(db, {
        hostId: host.id,
        canonicalPath: "/canonical/repo",
      }).map((event) => event.type),
    ).toEqual(["acquired", "waiting", "released", "promoted"]);
  });

  it("joins holder steers and cancels queued work without disturbing ownership", () => {
    const {
      db,
      firstEnvironment,
      firstThread,
      host,
      secondEnvironment,
      secondThread,
    } = setup();
    acquireUnmanagedWorkspaceMutationLease(db, {
      environmentId: firstEnvironment.id,
      requestId: "req-first",
      threadId: firstThread.id,
    });
    expect(
      acquireUnmanagedWorkspaceMutationLease(db, {
        environmentId: firstEnvironment.id,
        requestId: "steer-request",
        threadId: firstThread.id,
      }),
    ).toMatchObject({ outcome: "joined", generation: 1 });
    acquireUnmanagedWorkspaceMutationLease(db, {
      environmentId: secondEnvironment.id,
      requestId: "req-second",
      threadId: secondThread.id,
    });

    expect(
      cancelUnmanagedWorkspaceMutationWaiter(db, {
        reason: "manual stop",
        requestId: "req-second",
      }),
    ).toBe(true);
    expect(
      releaseUnmanagedWorkspaceMutationLease(db, {
        generation: 1,
        hostId: host.id,
        canonicalPath: "/canonical/repo",
        reason: "turn completed",
      }),
    ).toEqual({ released: true, promoted: null });
  });

  it("does not protect managed, destroyed, or differently addressed workspaces", () => {
    const { db, firstProject, host } = setup();
    const managed = createEnvironment(db, noopNotifier, {
      hostId: host.id,
      managed: true,
      path: "/canonical/managed",
      projectId: firstProject.id,
      status: "ready",
      workspaceProvisionType: "managed-worktree",
    });
    const destroyed = createEnvironment(db, noopNotifier, {
      hostId: host.id,
      path: "/canonical/destroyed",
      projectId: firstProject.id,
      status: "destroyed",
      workspaceProvisionType: "unmanaged",
    });

    expect(isUnmanagedWorkspaceMutationProtected(db, managed.id)).toBe(false);
    expect(isUnmanagedWorkspaceMutationProtected(db, destroyed.id)).toBe(false);
  });
});
