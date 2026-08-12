import { randomUUID as defaultRandomUUID } from "node:crypto";
import type {
  HostAdmissionReason,
  HostAdmissionReconcileResult,
  HostAdmissionReservation,
  HostAdmissionReserveResult,
} from "@bb/host-daemon-contract";
import type {
  RuntimeManagerProviderProcessDiagnostic,
  RuntimeManagerReapIdleProviderSessionsResult,
} from "./runtime-manager.js";

export type HostAdmissionReservationEntry =
  HostAdmissionReconcileResult["reservations"][number];

interface ReservationRecord {
  requestIds: Set<string>;
  reservation: HostAdmissionReservation;
  threadId: string;
}

export interface HostAdmissionControllerOptions {
  hostId: string;
  limit: number;
  listProviderProcessDiagnostics: () => RuntimeManagerProviderProcessDiagnostic[];
  reapIdleProviderSessions: (args: {
    idleForMs: number;
    nowMs: number;
  }) => Promise<RuntimeManagerReapIdleProviderSessionsResult>;
  nowMs?: () => number;
  randomUUID?: () => string;
}

export class HostAdmissionController {
  private admissionQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private readonly releasedRequestIds = new Set<string>();
  private readonly reservationsByToken = new Map<string, ReservationRecord>();
  private readonly tokenByRequestId = new Map<string, string>();
  private readonly tokenByThreadId = new Map<string, string>();

  constructor(private readonly options: HostAdmissionControllerOptions) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new Error("Host admission limit must be a positive integer");
    }
  }

  async reserve(args: {
    hostId: string;
    reason: HostAdmissionReason;
    requestId: string;
    threadId: string;
  }): Promise<HostAdmissionReserveResult> {
    const result = this.admissionQueue.then(() => this.reserveInOrder(args));
    this.admissionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async reserveInOrder(args: {
    hostId: string;
    reason: HostAdmissionReason;
    requestId: string;
    threadId: string;
  }): Promise<HostAdmissionReserveResult> {
    if (args.hostId !== this.options.hostId) {
      throw new Error("Admission request targets a different host");
    }
    if (this.releasedRequestIds.has(args.requestId)) {
      throw new Error("Admission request was already released");
    }
    const requestToken = this.tokenByRequestId.get(args.requestId);
    const requestRecord = requestToken
      ? this.reservationsByToken.get(requestToken)
      : undefined;
    if (requestRecord && requestRecord.threadId !== args.threadId) {
      throw new Error(
        "Admission request is already reserved for another thread",
      );
    }
    const existing = this.findExisting(args.requestId, args.threadId);
    if (existing) {
      existing.requestIds.add(args.requestId);
      this.tokenByRequestId.set(args.requestId, existing.reservation.token);
      return { outcome: "reserved", reservation: existing.reservation };
    }

    if (this.usedSlots() >= this.options.limit) {
      await this.options.reapIdleProviderSessions({
        idleForMs: 0,
        nowMs: (this.options.nowMs ?? Date.now)(),
      });
    }
    const used = this.usedSlots();
    if (used >= this.options.limit) {
      return {
        outcome: "unavailable",
        reason: `Host work limit reached (${used}/${this.options.limit}); waiting for a slot`,
      };
    }

    const reservation: HostAdmissionReservation = {
      token: (this.options.randomUUID ?? defaultRandomUUID)(),
      generation: ++this.generation,
      hostId: this.options.hostId,
      reason: args.reason,
    };
    const record: ReservationRecord = {
      requestIds: new Set([args.requestId]),
      reservation,
      threadId: args.threadId,
    };
    this.reservationsByToken.set(reservation.token, record);
    this.tokenByRequestId.set(args.requestId, reservation.token);
    this.tokenByThreadId.set(args.threadId, reservation.token);
    return { outcome: "reserved", reservation };
  }

  release(reservation: HostAdmissionReservation): { released: boolean } {
    const record = this.reservationsByToken.get(reservation.token);
    if (
      !record ||
      record.reservation.generation !== reservation.generation ||
      record.reservation.hostId !== reservation.hostId
    ) {
      return { released: false };
    }
    this.reservationsByToken.delete(reservation.token);
    this.tokenByThreadId.delete(record.threadId);
    for (const requestId of record.requestIds) {
      this.tokenByRequestId.delete(requestId);
      this.releasedRequestIds.add(requestId);
    }
    return { released: true };
  }

  validate(args: { requestId: string; threadId: string }): boolean {
    const token = this.tokenByRequestId.get(args.requestId);
    return (
      token !== undefined &&
      this.reservationsByToken.get(token)?.threadId === args.threadId
    );
  }

  listReservations(): HostAdmissionReservationEntry[] {
    return [...this.reservationsByToken.values()].map((record) => ({
      requestIds: [...record.requestIds],
      reservation: record.reservation,
      threadId: record.threadId,
    }));
  }

  private findExisting(
    requestId: string,
    threadId: string,
  ): ReservationRecord | undefined {
    const requestToken = this.tokenByRequestId.get(requestId);
    const threadToken = this.tokenByThreadId.get(threadId);
    const token = requestToken ?? threadToken;
    const record = token ? this.reservationsByToken.get(token) : undefined;
    return record?.threadId === threadId ? record : undefined;
  }

  private usedSlots(): number {
    const reservedThreads = new Set(
      [...this.reservationsByToken.values()].map((record) => record.threadId),
    );
    const residentProcesses = this.options
      .listProviderProcessDiagnostics()
      .filter(
        (process) =>
          process.state !== "finalizing" &&
          !process.sessions.some((session) =>
            reservedThreads.has(session.threadId),
          ),
      ).length;
    return this.reservationsByToken.size + residentProcesses;
  }
}
