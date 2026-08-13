import { Worker } from "node:worker_threads";
import {
  dbReadWorkerResponseSchema,
  threadListSnapshotInputSchema,
  timelineSnapshotInputSchema,
  type DbReadWorkerRequest,
  type DbReadWorkerResponse,
  type ThreadListSnapshotInput,
  type ThreadListSnapshotResult,
  type TimelineSnapshotInput,
  type TimelineSnapshotResult,
} from "./protocol.js";
import { ApiError, type ApiErrorOptions } from "../errors.js";

type DbReadOperation = DbReadWorkerRequest["operation"];
type DbReadResult = ThreadListSnapshotResult | TimelineSnapshotResult;

export interface DbReadRequestOptions {
  deadlineMs?: number;
  signal?: AbortSignal;
}

interface DbReadWorkerFactoryArgs {
  databasePath: string;
}

export interface CreateDbReadWorkerServiceOptions {
  databasePath: string;
  defaultDeadlineMs?: number;
  maxQueueSize?: number;
  readyTimeoutMs?: number;
  workerFactory?: (args: DbReadWorkerFactoryArgs) => Worker;
}

interface PendingRead {
  abortHandler: (() => void) | null;
  deadlineTimer: NodeJS.Timeout | null;
  deadlineMs: number;
  detached: boolean;
  input: ThreadListSnapshotInput | TimelineSnapshotInput;
  operation: DbReadOperation;
  reject: (error: Error) => void;
  requestId: string;
  resolve: (result: DbReadResult) => void;
  settled: boolean;
  signal: AbortSignal | undefined;
}

export interface DbReadWorkerService {
  ready(): Promise<void>;
  shutdown(): Promise<void>;
  threadListSnapshot(
    input: ThreadListSnapshotInput,
    options?: DbReadRequestOptions,
  ): Promise<ThreadListSnapshotResult>;
  timelineSnapshot(
    input: TimelineSnapshotInput,
    options?: DbReadRequestOptions,
  ): Promise<TimelineSnapshotResult>;
}

export class DbReadWorkerQueueFullError extends Error {
  constructor() {
    super("Database read worker queue is full");
    this.name = "DbReadWorkerQueueFullError";
  }
}

function abortError(): DOMException {
  return new DOMException("Database read was cancelled", "AbortError");
}

function deadlineError(): Error {
  return new Error("Database read worker request exceeded its deadline");
}

function shutdownError(): Error {
  return new Error("Database read worker service is shut down");
}

function operationError(
  error: Extract<DbReadWorkerResponse, { type: "error" }>["error"],
): Error {
  if (error.kind === "internal") {
    return new Error(error.message);
  }
  const options: ApiErrorOptions = {
    ...(error.details === undefined ? {} : { details: error.details }),
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
  };
  switch (error.status) {
    case 400:
      return new ApiError(400, error.code, error.message, options);
    case 413:
      return new ApiError(413, error.code, error.message, options);
    case 500:
      return new ApiError(500, error.code, error.message, options);
  }
}

export function createDbReadWorkerService(
  options: CreateDbReadWorkerServiceOptions,
): DbReadWorkerService {
  const defaultDeadlineMs = options.defaultDeadlineMs ?? 30_000;
  const maxQueueSize = options.maxQueueSize ?? 64;
  const readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
  if (!Number.isInteger(maxQueueSize) || maxQueueSize < 0) {
    throw new Error("maxQueueSize must be a non-negative integer");
  }
  if (
    !Number.isFinite(defaultDeadlineMs) ||
    defaultDeadlineMs <= 0 ||
    !Number.isFinite(readyTimeoutMs) ||
    readyTimeoutMs <= 0
  ) {
    throw new Error("Worker deadlines must be positive and finite");
  }

  let worker: Worker | null = null;
  let workerGeneration = 0;
  let workerReady = false;
  let isShutdown = false;
  let nextRequestId = 1;
  let inFlight: PendingRead | null = null;
  const queue: PendingRead[] = [];
  let initialReadySettled = false;
  let resolveInitialReady: (() => void) | null = null;
  let rejectInitialReady: ((error: Error) => void) | null = null;
  const initialReady = new Promise<void>((resolve, reject) => {
    resolveInitialReady = resolve;
    rejectInitialReady = reject;
  });
  void initialReady.catch(() => {});

  function cleanupPending(pending: PendingRead): void {
    if (pending.deadlineTimer) {
      clearTimeout(pending.deadlineTimer);
      pending.deadlineTimer = null;
    }
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
      pending.abortHandler = null;
    }
  }

  function settleRejected(pending: PendingRead, error: Error): void {
    if (pending.settled) {
      cleanupPending(pending);
      return;
    }
    pending.settled = true;
    cleanupPending(pending);
    pending.reject(error);
  }

  function settleResolved(pending: PendingRead, result: DbReadResult): void {
    if (pending.settled) {
      cleanupPending(pending);
      return;
    }
    pending.settled = true;
    cleanupPending(pending);
    pending.resolve(result);
  }

  function dispatchNext(): void {
    if (isShutdown || !worker || !workerReady || inFlight) {
      return;
    }
    const pending = queue.shift();
    if (!pending) {
      return;
    }
    inFlight = pending;
    pending.deadlineTimer = setTimeout(() => {
      if (inFlight === pending) {
        replaceWorker(deadlineError());
      }
    }, pending.deadlineMs);
    pending.deadlineTimer.unref();
    const request: DbReadWorkerRequest =
      pending.operation === "threadListSnapshot"
        ? {
            type: "request",
            requestId: pending.requestId,
            operation: "threadListSnapshot",
            input: threadListSnapshotInputSchema.parse(pending.input),
          }
        : {
            type: "request",
            requestId: pending.requestId,
            operation: "timelineSnapshot",
            input: timelineSnapshotInputSchema.parse(pending.input),
          };
    worker.postMessage(request);
  }

  function replaceWorker(error: Error): void {
    const failedWorker = worker;
    worker = null;
    workerReady = false;
    workerGeneration += 1;
    if (inFlight) {
      const failed = inFlight;
      inFlight = null;
      settleRejected(failed, error);
    }
    if (failedWorker) {
      void failedWorker.terminate();
    }
    if (!isShutdown) {
      spawnWorker();
    }
  }

  function handleWorkerMessage(generation: number, value: unknown): void {
    if (generation !== workerGeneration || isShutdown) {
      return;
    }
    const parsed = dbReadWorkerResponseSchema.safeParse(value);
    if (!parsed.success) {
      replaceWorker(new Error("Database read worker sent an invalid response"));
      return;
    }
    const message = parsed.data;
    if (message.type === "ready") {
      workerReady = true;
      if (!initialReadySettled) {
        initialReadySettled = true;
        resolveInitialReady?.();
      }
      dispatchNext();
      return;
    }
    const pending = inFlight;
    if (
      !pending ||
      message.requestId !== pending.requestId ||
      message.operation !== pending.operation
    ) {
      replaceWorker(
        new Error("Database read worker sent a mismatched response"),
      );
      return;
    }
    inFlight = null;
    if (message.type === "error") {
      settleRejected(pending, operationError(message.error));
    } else if (!pending.detached) {
      settleResolved(pending, message.result);
    } else {
      cleanupPending(pending);
    }
    dispatchNext();
  }

  function spawnWorker(): void {
    const generation = workerGeneration;
    const nextWorker = options.workerFactory
      ? options.workerFactory({ databasePath: options.databasePath })
      : new Worker(
          new URL(
            import.meta.url.endsWith(".ts")
              ? "./worker.ts"
              : "./db-read-worker/worker.js",
            import.meta.url,
          ),
          {
            ...(import.meta.url.endsWith(".ts")
              ? { execArgv: ["--import", "tsx"] }
              : {}),
            workerData: {
              databasePath: options.databasePath,
              role: "db-read-worker",
            },
          },
        );
    worker = nextWorker;
    workerReady = false;
    const readyTimer = setTimeout(() => {
      if (generation === workerGeneration && !workerReady) {
        const error = new Error("Database read worker readiness timed out");
        if (!initialReadySettled) {
          initialReadySettled = true;
          rejectInitialReady?.(error);
          isShutdown = true;
          for (const pending of queue.splice(0)) {
            settleRejected(pending, error);
          }
        }
        replaceWorker(error);
      }
    }, readyTimeoutMs);
    readyTimer.unref();
    nextWorker.on("message", (message: unknown) => {
      if (
        message !== null &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "ready"
      ) {
        clearTimeout(readyTimer);
      }
      handleWorkerMessage(generation, message);
    });
    nextWorker.once("error", (error) => {
      if (generation === workerGeneration && !isShutdown) {
        replaceWorker(error);
      }
    });
    nextWorker.once("exit", (code) => {
      if (generation === workerGeneration && !isShutdown) {
        replaceWorker(
          new Error(
            `Database read worker exited unexpectedly with code ${code}`,
          ),
        );
      }
    });
  }

  function enqueue(
    operation: DbReadOperation,
    input: ThreadListSnapshotInput | TimelineSnapshotInput,
    requestOptions: DbReadRequestOptions,
  ): Promise<DbReadResult> {
    if (isShutdown) {
      return Promise.reject(shutdownError());
    }
    const parsedInput =
      operation === "threadListSnapshot"
        ? threadListSnapshotInputSchema.parse(input)
        : timelineSnapshotInputSchema.parse(input);
    if (requestOptions.signal?.aborted) {
      return Promise.reject(abortError());
    }
    const outstandingCount = queue.length + (inFlight === null ? 0 : 1);
    if (outstandingCount >= maxQueueSize + 1) {
      return Promise.reject(new DbReadWorkerQueueFullError());
    }
    const deadlineMs = requestOptions.deadlineMs ?? defaultDeadlineMs;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      return Promise.reject(
        new Error("deadlineMs must be positive and finite"),
      );
    }

    return new Promise<DbReadResult>((resolve, reject) => {
      const pending: PendingRead = {
        abortHandler: null,
        deadlineTimer: null,
        deadlineMs,
        detached: false,
        input: parsedInput,
        operation,
        reject,
        requestId: `db-read-${nextRequestId++}`,
        resolve,
        settled: false,
        signal: requestOptions.signal,
      };
      if (requestOptions.signal) {
        pending.abortHandler = () => {
          if (inFlight === pending) {
            pending.detached = true;
            pending.settled = true;
            if (pending.signal && pending.abortHandler) {
              pending.signal.removeEventListener("abort", pending.abortHandler);
              pending.abortHandler = null;
            }
            // The caller is detached, but the synchronous worker operation is
            // still running. Keep its deadline armed so an abandoned hung read
            // cannot permanently strand the FIFO.
            pending.reject(abortError());
            return;
          }
          const index = queue.indexOf(pending);
          if (index >= 0) {
            queue.splice(index, 1);
            settleRejected(pending, abortError());
            dispatchNext();
          }
        };
        requestOptions.signal.addEventListener("abort", pending.abortHandler, {
          once: true,
        });
      }
      queue.push(pending);
      dispatchNext();
    });
  }

  spawnWorker();

  return {
    ready: () => initialReady,
    async shutdown(): Promise<void> {
      if (isShutdown) {
        return;
      }
      isShutdown = true;
      if (!initialReadySettled) {
        initialReadySettled = true;
        rejectInitialReady?.(shutdownError());
      }
      if (inFlight) {
        settleRejected(inFlight, shutdownError());
        inFlight = null;
      }
      for (const pending of queue.splice(0)) {
        settleRejected(pending, shutdownError());
      }
      const currentWorker = worker;
      worker = null;
      workerGeneration += 1;
      if (currentWorker) {
        await currentWorker.terminate();
      }
    },
    threadListSnapshot: async (input, requestOptions = {}) => {
      const result = await enqueue("threadListSnapshot", input, requestOptions);
      return threadListSnapshotInputSchema.parse(input) && Array.isArray(result)
        ? result
        : Promise.reject(
            new Error(
              "Database read worker returned the wrong operation result",
            ),
          );
    },
    timelineSnapshot: async (input, requestOptions = {}) => {
      const result = await enqueue("timelineSnapshot", input, requestOptions);
      if (Array.isArray(result)) {
        throw new Error(
          "Database read worker returned the wrong operation result",
        );
      }
      return result;
    },
  };
}
