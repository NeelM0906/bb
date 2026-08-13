import { describe, expect, it, vi } from "vitest";
import { HostAdmissionController } from "./host-admission-controller.js";

describe("HostAdmissionController", () => {
  it("shares one atomic limit across every work source", async () => {
    const controller = new HostAdmissionController({
      hostId: "host-1",
      limit: 2,
      listProviderProcessDiagnostics: () => [],
      reapIdleProviderSessions: vi
        .fn()
        .mockResolvedValue({ reapedSessions: [] }),
      randomUUID: vi
        .fn()
        .mockReturnValueOnce("token-1")
        .mockReturnValueOnce("token-2"),
    });

    const first = await controller.reserve({
      hostId: "host-1",
      requestId: "req-interactive",
      threadId: "thread-interactive",
      reason: "interactive",
    });
    const second = await controller.reserve({
      hostId: "host-1",
      requestId: "req-child",
      threadId: "thread-child",
      reason: "child",
    });

    expect(first).toMatchObject({
      outcome: "reserved",
      reservation: {
        token: "token-1",
        generation: 1,
        hostId: "host-1",
        reason: "interactive",
      },
    });
    expect(second).toMatchObject({ outcome: "reserved" });
    for (const [requestId, threadId, reason] of [
      ["req-automation", "thread-automation", "automation"],
      ["req-queued", "thread-queued", "queued"],
      ["req-resumed", "thread-resumed", "resumed"],
    ] as const) {
      await expect(
        controller.reserve({ hostId: "host-1", requestId, threadId, reason }),
      ).resolves.toEqual({
        outcome: "unavailable",
        reason: "Host work limit reached (2/2); waiting for a slot",
      });
    }
  });

  it("reclaims idle provider leases before reporting no capacity", async () => {
    let resident = true;
    const reapIdleProviderSessions = vi.fn(async () => {
      resident = false;
      return { reapedSessions: [] };
    });
    const controller = new HostAdmissionController({
      hostId: "host-1",
      limit: 1,
      listProviderProcessDiagnostics: () =>
        resident
          ? [
              {
                directPid: 12,
                environmentId: "env-1",
                generation: 1,
                processKey: "process-1",
                providerId: "codex",
                sessions: [
                  {
                    activeTurnId: null,
                    idleDeadlineMs: 10,
                    providerThreadId: "provider-thread-1",
                    threadId: "resident-thread",
                  },
                ],
                state: "running" as const,
              },
            ]
          : [],
      reapIdleProviderSessions,
      randomUUID: () => "token-1",
      nowMs: () => 20,
    });

    await expect(
      controller.reserve({
        hostId: "host-1",
        requestId: "req-1",
        threadId: "thread-1",
        reason: "interactive",
      }),
    ).resolves.toMatchObject({ outcome: "reserved" });
    expect(reapIdleProviderSessions).toHaveBeenCalledWith({
      idleForMs: 0,
      nowMs: 20,
    });
  });

  it("settles concurrent admission attempts in FIFO request order", async () => {
    let resident = true;
    let finishFirstReap: (() => void) | undefined;
    const firstReap = new Promise<void>((resolve) => {
      finishFirstReap = resolve;
    });
    const reapIdleProviderSessions = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstReap;
        resident = false;
        return { reapedSessions: [] };
      })
      .mockImplementationOnce(async () => {
        resident = false;
        return { reapedSessions: [] };
      });
    const controller = new HostAdmissionController({
      hostId: "host-1",
      limit: 1,
      listProviderProcessDiagnostics: () =>
        resident
          ? [
              {
                directPid: 12,
                environmentId: "env-1",
                generation: 1,
                processKey: "process-1",
                providerId: "codex",
                sessions: [
                  {
                    activeTurnId: null,
                    idleDeadlineMs: 10,
                    providerThreadId: "provider-thread-1",
                    threadId: "resident-thread",
                  },
                ],
                state: "running" as const,
              },
            ]
          : [],
      reapIdleProviderSessions,
      randomUUID: () => "token-1",
      nowMs: () => 20,
    });

    const first = controller.reserve({
      hostId: "host-1",
      requestId: "req-first",
      threadId: "thread-first",
      reason: "interactive",
    });
    await vi.waitFor(() => {
      expect(reapIdleProviderSessions).toHaveBeenCalledTimes(1);
    });
    const second = controller.reserve({
      hostId: "host-1",
      requestId: "req-second",
      threadId: "thread-second",
      reason: "automation",
    });
    finishFirstReap?.();

    await expect(first).resolves.toMatchObject({ outcome: "reserved" });
    await expect(second).resolves.toEqual({
      outcome: "unavailable",
      reason: "Host work limit reached (1/1); waiting for a slot",
    });
  });

  it("rejects stale releases without freeing a successor generation", async () => {
    const controller = new HostAdmissionController({
      hostId: "host-1",
      limit: 1,
      listProviderProcessDiagnostics: () => [],
      reapIdleProviderSessions: vi
        .fn()
        .mockResolvedValue({ reapedSessions: [] }),
      randomUUID: vi
        .fn()
        .mockReturnValueOnce("reused-token")
        .mockReturnValueOnce("reused-token"),
    });
    const first = await controller.reserve({
      hostId: "host-1",
      requestId: "req-1",
      threadId: "thread-1",
      reason: "interactive",
    });
    if (first.outcome !== "reserved") throw new Error("expected reservation");
    expect(controller.release(first.reservation)).toEqual({ released: true });

    const successor = await controller.reserve({
      hostId: "host-1",
      requestId: "req-2",
      threadId: "thread-2",
      reason: "queued",
    });
    if (successor.outcome !== "reserved") {
      throw new Error("expected successor reservation");
    }
    expect(successor.reservation.generation).toBe(2);
    expect(controller.release(first.reservation)).toEqual({ released: false });
    expect(
      controller.validate({ requestId: "req-2", threadId: "thread-2" }),
    ).toBe(true);
  });

  it("reuses a thread reservation for steering without consuming another slot", async () => {
    const controller = new HostAdmissionController({
      hostId: "host-1",
      limit: 1,
      listProviderProcessDiagnostics: () => [],
      reapIdleProviderSessions: vi
        .fn()
        .mockResolvedValue({ reapedSessions: [] }),
      randomUUID: () => "token-1",
    });
    const first = await controller.reserve({
      hostId: "host-1",
      requestId: "req-start",
      threadId: "thread-1",
      reason: "interactive",
    });
    const steer = await controller.reserve({
      hostId: "host-1",
      requestId: "req-steer",
      threadId: "thread-1",
      reason: "queued",
    });

    expect(steer).toEqual(first);
    expect(
      controller.validate({ requestId: "req-steer", threadId: "thread-1" }),
    ).toBe(true);
    expect(controller.listReservations()).toHaveLength(1);
  });

  it("does not rebind a retryable request id to another thread", async () => {
    const controller = new HostAdmissionController({
      hostId: "host-1",
      limit: 2,
      listProviderProcessDiagnostics: () => [],
      reapIdleProviderSessions: vi
        .fn()
        .mockResolvedValue({ reapedSessions: [] }),
      randomUUID: () => "token-1",
    });
    const first = await controller.reserve({
      hostId: "host-1",
      requestId: "req-retried",
      threadId: "thread-1",
      reason: "interactive",
    });

    await expect(
      controller.reserve({
        hostId: "host-1",
        requestId: "req-retried",
        threadId: "thread-2",
        reason: "resumed",
      }),
    ).rejects.toThrow(
      "Admission request is already reserved for another thread",
    );
    expect(controller.listReservations()).toHaveLength(1);
    expect(
      controller.validate({ requestId: "req-retried", threadId: "thread-1" }),
    ).toBe(true);
    expect(first).toMatchObject({ outcome: "reserved" });
  });

  it("rejects a reservation addressed to a different host", async () => {
    const controller = new HostAdmissionController({
      hostId: "host-1",
      limit: 1,
      listProviderProcessDiagnostics: () => [],
      reapIdleProviderSessions: vi
        .fn()
        .mockResolvedValue({ reapedSessions: [] }),
      randomUUID: () => "token-1",
    });

    await expect(
      controller.reserve({
        hostId: "host-2",
        requestId: "req-wrong-host",
        threadId: "thread-1",
        reason: "interactive",
      }),
    ).rejects.toThrow("Admission request targets a different host");
    expect(controller.listReservations()).toEqual([]);
  });

  it("does not resurrect a released request when reserve is replayed", async () => {
    const controller = new HostAdmissionController({
      hostId: "host-1",
      limit: 1,
      listProviderProcessDiagnostics: () => [],
      reapIdleProviderSessions: vi
        .fn()
        .mockResolvedValue({ reapedSessions: [] }),
      randomUUID: () => "token-1",
    });
    const first = await controller.reserve({
      hostId: "host-1",
      requestId: "req-replayed",
      threadId: "thread-1",
      reason: "interactive",
    });
    if (first.outcome !== "reserved") throw new Error("expected reservation");
    expect(controller.release(first.reservation)).toEqual({ released: true });

    await expect(
      controller.reserve({
        hostId: "host-1",
        requestId: "req-replayed",
        threadId: "thread-1",
        reason: "interactive",
      }),
    ).rejects.toThrow("Admission request was already released");
    expect(controller.listReservations()).toEqual([]);
  });
});
