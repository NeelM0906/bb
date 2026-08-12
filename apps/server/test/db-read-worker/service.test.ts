import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  createDbReadWorkerService,
  DbReadWorkerQueueFullError,
} from "../../src/db-read-worker/service.js";

const fixtureWorkerUrl = new URL("./fixture-worker.mjs", import.meta.url);

function createService(
  options: {
    defaultDeadlineMs?: number;
    maxQueueSize?: number;
  } = {},
) {
  return createDbReadWorkerService({
    databasePath: "/unused/test.db",
    defaultDeadlineMs: options.defaultDeadlineMs ?? 1_000,
    maxQueueSize: options.maxQueueSize ?? 4,
    readyTimeoutMs: 1_000,
    workerFactory: () => new Worker(fixtureWorkerUrl),
  });
}

function listInput(offset: number) {
  return {
    kind: "list" as const,
    now: 1_000,
    options: { offset },
  };
}

describe("DbReadWorkerService", () => {
  it("waits for readiness and resolves queued reads in FIFO order", async () => {
    const service = createService();
    const completionOrder: number[] = [];

    const first = service
      .threadListSnapshot(listInput(1))
      .then(() => completionOrder.push(1));
    const second = service
      .threadListSnapshot(listInput(2))
      .then(() => completionOrder.push(2));
    const third = service
      .threadListSnapshot(listInput(3))
      .then(() => completionOrder.push(3));

    await service.ready();
    await Promise.all([first, second, third]);
    expect(completionOrder).toEqual([1, 2, 3]);
    await service.shutdown();
  });

  it("rejects readiness when a worker never becomes ready", async () => {
    const service = createDbReadWorkerService({
      databasePath: "/unused/test.db",
      readyTimeoutMs: 25,
      workerFactory: () =>
        new Worker(new URL("data:text/javascript,setInterval(() => {}, 1000)")),
    });

    await expect(service.ready()).rejects.toThrow(/readiness timed out/i);
    await service.shutdown();
  });

  it("rejects reads queued behind a worker that never becomes ready", async () => {
    const service = createDbReadWorkerService({
      databasePath: "/unused/test.db",
      readyTimeoutMs: 25,
      workerFactory: () =>
        new Worker(new URL("data:text/javascript,setInterval(() => {}, 1000)")),
    });
    const pending = service.threadListSnapshot(listInput(1));

    await expect(service.ready()).rejects.toThrow(/readiness timed out/i);
    await expect(pending).rejects.toThrow(/readiness timed out/i);
    await service.shutdown();
  });

  it("rejects work beyond the bounded queued capacity", async () => {
    const service = createService({ maxQueueSize: 1 });
    const first = service.threadListSnapshot(listInput(1));
    const second = service.threadListSnapshot(listInput(2));

    await expect(
      service.threadListSnapshot(listInput(3)),
    ).rejects.toBeInstanceOf(DbReadWorkerQueueFullError);
    await Promise.all([first, second]);
    await service.shutdown();
  });

  it("allows one immediately dispatched read with no queued capacity", async () => {
    const service = createService({ maxQueueSize: 0 });
    await service.ready();

    const inFlight = service.threadListSnapshot(listInput(1));
    await expect(
      service.threadListSnapshot(listInput(2)),
    ).rejects.toBeInstanceOf(DbReadWorkerQueueFullError);
    await expect(inFlight).resolves.toEqual([]);
    await service.shutdown();
  });

  it("rejects non-finite worker deadlines", async () => {
    expect(() => createService({ defaultDeadlineMs: Infinity })).toThrow(
      /finite/i,
    );
    const service = createService();

    await expect(
      service.threadListSnapshot(listInput(1), { deadlineMs: Infinity }),
    ).rejects.toThrow(/finite/i);
    await service.shutdown();
  });

  it("removes queued cancellation and admits the next read", async () => {
    const service = createService({ maxQueueSize: 1 });
    const first = service.threadListSnapshot(listInput(1));
    const abortController = new AbortController();
    const cancelled = service.threadListSnapshot(listInput(2), {
      signal: abortController.signal,
    });
    abortController.abort();

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const replacement = service.threadListSnapshot(listInput(3));
    await Promise.all([first, replacement]);
    await service.shutdown();
  });

  it("detaches an aborted in-flight caller without replacing the worker", async () => {
    const service = createService();
    await service.ready();
    const abortController = new AbortController();
    const cancelled = service.threadListSnapshot(listInput(1), {
      signal: abortController.signal,
    });
    const following = service.threadListSnapshot(listInput(2));
    abortController.abort();

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(following).resolves.toEqual([]);
    await service.shutdown();
  });

  it("keeps the deadline armed after an in-flight caller detaches", async () => {
    const service = createService({ defaultDeadlineMs: 50 });
    await service.ready();
    const abortController = new AbortController();
    const cancelledHungRead = service.threadListSnapshot(listInput(999), {
      signal: abortController.signal,
    });
    const following = service.threadListSnapshot(listInput(2));
    abortController.abort();

    await expect(cancelledHungRead).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(following).resolves.toEqual([]);
    await service.shutdown();
  });

  it("replaces a worker after an in-flight deadline", async () => {
    const service = createService({ defaultDeadlineMs: 50 });
    const hung = service.threadListSnapshot(listInput(999));
    const following = service.threadListSnapshot(listInput(2));

    await expect(hung).rejects.toThrow(/deadline/i);
    await expect(following).resolves.toEqual([]);
    await service.shutdown();
  });

  it.each([
    { name: "malformed output", offset: 998, message: /invalid/i },
    { name: "worker crash", offset: 997, message: /exited/i },
  ])("restarts after $name", async ({ message, offset }) => {
    const service = createService();
    const failed = service.threadListSnapshot(listInput(offset));
    const following = service.threadListSnapshot(listInput(2));

    await expect(failed).rejects.toThrow(message);
    await expect(following).resolves.toEqual([]);
    await service.shutdown();
  });

  it("rejects pending work and terminates cleanly on shutdown", async () => {
    const service = createService();
    const hung = service.threadListSnapshot(listInput(999));
    const queued = service.threadListSnapshot(listInput(2));
    void hung.catch(() => {});
    void queued.catch(() => {});

    await service.shutdown();
    await expect(hung).rejects.toThrow(/shut down/i);
    await expect(queued).rejects.toThrow(/shut down/i);
    await expect(service.threadListSnapshot(listInput(3))).rejects.toThrow(
      /shut down/i,
    );
  });
});
