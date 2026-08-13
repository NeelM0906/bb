import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import {
  createWorkAdmission,
  getCurrentThreadWorkAdmission,
  listWaitingWorkAdmissions,
  markWorkAdmissionRunning,
  markWorkAdmissionTerminal,
} from "../../src/data/work-admissions.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";

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
  return { db, firstThread, host, secondThread };
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
});
