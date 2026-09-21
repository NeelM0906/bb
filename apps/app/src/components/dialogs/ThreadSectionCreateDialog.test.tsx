// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadSectionCreateDialog } from "./ThreadSectionCreateDialog";

const pointer = vi.hoisted(() => ({ coarse: false }));
vi.mock("@bb/shared-ui/hooks/use-pointer-coarse", () => ({
  usePointerCoarse: () => pointer.coarse,
}));
afterEach(() => {
  cleanup();
  pointer.coarse = false;
});
it("focuses the deferred form, validates and resets on reopen", async () => {
  const onCreate = vi.fn();
  const onOpenChange = vi.fn();
  const { rerender } = render(
    <ThreadSectionCreateDialog
      open
      onCreate={onCreate}
      onOpenChange={onOpenChange}
    />,
  );
  expect(screen.getByRole("dialog")).toBeDefined();
  const input = await screen.findByRole("textbox", { name: "Section name" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  fireEvent.click(screen.getByRole("button", { name: "Create section" }));
  expect(screen.getByText("Section name cannot be empty.")).toBeDefined();
  expect(onCreate).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "  Work  " } });
  fireEvent.click(screen.getByRole("button", { name: "Create section" }));
  expect(onCreate).toHaveBeenCalledWith("Work");
  rerender(
    <ThreadSectionCreateDialog
      open={false}
      onCreate={onCreate}
      onOpenChange={onOpenChange}
    />,
  );
  rerender(
    <ThreadSectionCreateDialog
      open
      onCreate={onCreate}
      onOpenChange={onOpenChange}
    />,
  );
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "Section name",
      })) as HTMLInputElement
    ).value,
  ).toBe("");
});

it("does not focus the deferred section input on a coarse pointer", async () => {
  pointer.coarse = true;
  render(
    <ThreadSectionCreateDialog
      open
      onCreate={vi.fn()}
      onOpenChange={vi.fn()}
    />,
  );
  const input = await screen.findByRole("textbox", { name: "Section name" });
  expect(document.activeElement).not.toBe(input);
});
