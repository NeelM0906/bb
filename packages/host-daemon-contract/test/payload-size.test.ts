import { gzipSync } from "node:zlib";
import { turnScope, type ThreadEvent } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
  ungroupHostDaemonEvents,
} from "../src/session.js";

interface PayloadSize {
  gzipBytes: number;
  jsonBytes: number;
}

function payloadSize(value: unknown): PayloadSize {
  const json = JSON.stringify(value);
  return {
    gzipBytes: gzipSync(json).byteLength,
    jsonBytes: Buffer.byteLength(json),
  };
}

function event(index: number): ThreadEvent {
  return {
    type: "item/agentMessage/delta",
    threadId: "thr_payload_measurement_123456789",
    providerThreadId: "provider_payload_measurement_123456789",
    scope: turnScope("turn_payload_measurement_123456789"),
    itemId: "item_payload_measurement_123456789",
    delta: `streamed token chunk ${index} `,
  };
}

describe("daemon-to-server event payload sizes", () => {
  it("preserves event order when a thread recurs after another thread", () => {
    const envelopes: HostDaemonEventEnvelope[] = [
      { threadId: "thr_a", event: event(1) },
      { threadId: "thr_b", event: event(2) },
      { threadId: "thr_a", event: event(3) },
    ];

    const groups = groupHostDaemonEvents(envelopes);

    expect(groups.map((group) => group.threadId)).toEqual([
      "thr_a",
      "thr_b",
      "thr_a",
    ]);
    expect(ungroupHostDaemonEvents(groups)).toEqual(envelopes);
  });

  it("records legacy-envelope and grouped sizes across representative batches", () => {
    const measurements = [1, 10, 50].map((eventCount) => {
      const events: HostDaemonEventEnvelope[] = Array.from(
        { length: eventCount },
        (_, index) => ({
          threadId: "thr_payload_measurement_123456789",
          event: event(index),
        }),
      );
      const legacyPayload = {
        sessionId: "session_payload_measurement_123456789",
        events,
      };
      const groupedPayload = {
        sessionId: "session_payload_measurement_123456789",
        eventGroups: groupHostDaemonEvents(events),
      };
      return {
        eventCount,
        legacyEnvelope: payloadSize(legacyPayload),
        grouped: payloadSize(groupedPayload),
      };
    });

    const expected = [
      {
        eventCount: 1,
        legacyEnvelope: { gzipBytes: 194, jsonBytes: 413 },
        grouped: { gzipBytes: 198, jsonBytes: 421 },
      },
      {
        eventCount: 10,
        legacyEnvelope: { gzipBytes: 246, jsonBytes: 3_554 },
        grouped: { gzipBytes: 247, jsonBytes: 3_049 },
      },
      {
        eventCount: 50,
        legacyEnvelope: { gzipBytes: 406, jsonBytes: 17_554 },
        grouped: { gzipBytes: 407, jsonBytes: 14_769 },
      },
    ];
    expect(
      measurements.map((measurement) => ({
        eventCount: measurement.eventCount,
        legacyEnvelopeJsonBytes: measurement.legacyEnvelope.jsonBytes,
        groupedJsonBytes: measurement.grouped.jsonBytes,
      })),
    ).toEqual(
      expected.map((measurement) => ({
        eventCount: measurement.eventCount,
        legacyEnvelopeJsonBytes: measurement.legacyEnvelope.jsonBytes,
        groupedJsonBytes: measurement.grouped.jsonBytes,
      })),
    );

    // zlib output varies slightly across Node/platform builds even when the
    // source bytes are identical. Keep a tight regression window instead of a
    // non-portable exact compressed-byte snapshot.
    for (const [index, measurement] of measurements.entries()) {
      const baseline = expected[index];
      if (baseline === undefined) {
        throw new Error(`Missing payload-size baseline at index ${index}`);
      }
      for (const key of ["legacyEnvelope", "grouped"] as const) {
        expect(measurement[key].gzipBytes).toBeGreaterThanOrEqual(
          baseline[key].gzipBytes - 8,
        );
        expect(measurement[key].gzipBytes).toBeLessThanOrEqual(
          baseline[key].gzipBytes + 8,
        );
      }
    }

    for (const measurement of measurements.slice(1)) {
      expect(measurement.grouped.jsonBytes).toBeLessThan(
        measurement.legacyEnvelope.jsonBytes,
      );
    }
  });
});
