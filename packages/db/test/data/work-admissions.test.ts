import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import {
  createWorkAdmission,
  getCurrentThreadWorkAdmission,
  getFirstHostEligibleWaitingAdmission,
  listWaitingWorkAdmissions,
  listCurrentWorkAdmissions,
  markWorkAdmissionRunning,
  markWorkAdmissionTerminal,
} from "../../src/data/work-admissions.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import { unmanagedWorkspaceMutationWaiters } from "../../src/schema.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "admission-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "admission-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/admission" },
  });
  const firstThread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  const secondThread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  const environment = createEnvironment(db, noopNotifier, {
    hostId: host.id,
    path: "/tmp/admission",
    projectId: project.id,
    status: "ready",
    workspaceProvisionType: "unmanaged",
  });
  return { db, environment, firstThread, host, secondThread };
}

describe("durable work admissions", () => {
  it("returns waiting work in persisted FIFO order after reopening the database", () => {
    const { db, firstThread, host, secondThread } = setup();
    createWorkAdmission(db, {
      commandJson: '{"type":"thread.start","requestId":"req-2"}',
      createdAt: 20,
      hostId: host.id,
      id: "req-2",
      reason: "child",
      threadId: secondThread.id,
      waitingReason: "Host capacity limit reached",
    });
    createWorkAdmission(db, {
      commandJson: '{"type":"thread.start","requestId":"req-1"}',
      createdAt: 10,
      hostId: host.id,
      id: "req-1",
      reason: "interactive",
      threadId: firstThread.id,
      waitingReason: "Host capacity limit reached",
    });

    expect(listWaitingWorkAdmissions(db, { hostId: host.id })).toEqual([
      expect.objectContaining({ id: "req-1", threadId: firstThread.id }),
      expect.objectContaining({ id: "req-2", threadId: secondThread.id }),
    ]);
  });

  it("selects the first host-eligible row without loading workspace waiters", () => {
    const { db, environment, firstThread, host, secondThread } = setup();
    createWorkAdmission(db, {
      commandJson: '{"requestId":"req-blocked"}',
      createdAt: 10,
      hostId: host.id,
      id: "req-blocked",
      reason: "interactive",
      threadId: firstThread.id,
      waitingReason: "Workspace is busy",
    });
    createWorkAdmission(db, {
      commandJson: '{"requestId":"req-eligible"}',
      createdAt: 20,
      hostId: host.id,
      id: "req-eligible",
      reason: "child",
      threadId: secondThread.id,
      waitingReason: "Awaiting host capacity",
    });
    db.insert(unmanagedWorkspaceMutationWaiters)
      .values({
        canonicalPath: "/tmp/admission",
        createdAt: 10,
        environmentId: environment.id,
        hostId: host.id,
        requestId: "req-blocked",
        state: "waiting",
        threadId: firstThread.id,
        updatedAt: 10,
      })
      .run();

    expect(
      getFirstHostEligibleWaitingAdmission(db, host.id),
    ).toMatchObject({ id: "req-eligible" });
  });

  it("generation-checks terminal settlement so stale completion cannot clear a successor", () => {
    const { db, firstThread, host } = setup();
    createWorkAdmission(db, {
      commandJson: '{"type":"turn.submit","requestId":"req-1"}',
      createdAt: 10,
      hostId: host.id,
      id: "req-1",
      reason: "resumed",
      threadId: firstThread.id,
      waitingReason: "Awaiting host capacity",
    });
    expect(
      markWorkAdmissionRunning(db, {
        id: "req-1",
        reservationGeneration: 7,
        reservationToken: "reservation-7",
      }),
    ).toBe(true);

    expect(
      markWorkAdmissionTerminal(db, {
        id: "req-1",
        reservationGeneration: 6,
        terminalReason: "turn completed",
      }),
    ).toBe(false);
    expect(getCurrentThreadWorkAdmission(db, firstThread.id)).toMatchObject({
      id: "req-1",
      reservationGeneration: 7,
      status: "running",
    });

    expect(
      markWorkAdmissionTerminal(db, {
        id: "req-1",
        reservationGeneration: 7,
        terminalReason: "turn completed",
      }),
    ).toBe(true);
    expect(getCurrentThreadWorkAdmission(db, firstThread.id)).toBeNull();
  });

  it("persists every accepted command for one thread independently", () => {
    const { db, firstThread, host } = setup();
    for (const [id, commandJson, createdAt] of [
      ["req-first", '{"requestId":"req-first"}', 10],
      ["req-second", '{"requestId":"req-second"}', 20],
    ] as const) {
      createWorkAdmission(db, {
        commandJson,
        createdAt,
        hostId: host.id,
        id,
        reason: "interactive",
        threadId: firstThread.id,
        waitingReason: "Awaiting host capacity",
      });
    }

    expect(
      listCurrentWorkAdmissions(db, { hostId: host.id }).map((row) => ({
        commandJson: row.commandJson,
        id: row.id,
      })),
    ).toEqual([
      { commandJson: '{"requestId":"req-first"}', id: "req-first" },
      { commandJson: '{"requestId":"req-second"}', id: "req-second" },
    ]);
  });
});
