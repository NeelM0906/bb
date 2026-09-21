// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ServerMoveOverlayView } from "./ServerMoveOverlayView";

const chunk = vi.hoisted(() => {
  let reject!: (reason: Error) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject: (reason: Error) => reject(reason) };
});
vi.mock("./ServerMoveStepList", () => chunk.promise);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps recovery controls and the blocking shell when step details are pending or fail", async () => {
  vi.useFakeTimers();
  const onCancel = vi.fn();
  render(
    <ServerMoveOverlayView
      content={{
        kind: "recovery",
        move: {
          moveId: "move_1",
          state: "recovery_required",
          mode: "connect",
          targetHostId: "host_desk",
          targetHostName: "desk",
          serverUrl: "https://example.com",
          destinationStatusUrl: null,
          startedAt: 1000,
          finishedAt: null,
          error: null,
          cancellable: false,
          steps: [{ id: "switch", status: "running", message: null }],
        },
      }}
      cancelPending={false}
      cancelError={null}
      onCancel={onCancel}
      onClose={vi.fn()}
    />,
  );
  const overlay = screen.getByRole("dialog");
  expect(document.activeElement).toBe(overlay);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(within(overlay).getByRole("status").textContent).toBe(
    "Loading move steps…",
  );
  fireEvent.click(
    within(overlay).getByRole("button", { name: "Abandon move…" }),
  );
  await act(async () => {
    chunk.reject(new Error("Asset unavailable during handoff"));
    await vi.dynamicImportSettled();
  });
  expect(screen.getByRole("dialog")).toBe(overlay);
  expect(within(overlay).getByRole("status").textContent).toBe(
    "Move step details are unavailable.",
  );
  fireEvent.click(
    within(overlay).getByRole("button", { name: "Abandon move" }),
  );
  expect(onCancel).toHaveBeenCalledOnce();
});
