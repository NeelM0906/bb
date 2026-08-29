import { describe, expect, it, vi } from "vitest";

import {
  scrollUsedBy,
  usedByScrollState,
  usedByScrollStep,
} from "../src/index";

/** A row wide enough for its items: the common case, and it shows no carets. */
const FITS = { scrollLeft: 0, scrollWidth: 180, clientWidth: 240 };
/** Fourteen plugin names in a card-width row, scrolled to the start. */
const AT_START = { scrollLeft: 0, scrollWidth: 900, clientWidth: 240 };

describe("usedByScrollState", () => {
  it("offers no carets when the items fit", () => {
    expect(usedByScrollState(FITS)).toEqual({
      canScrollLeft: false,
      canScrollRight: false,
    });
  });

  it("offers no carets for a row that is exactly full, or over by a rounding error", () => {
    // Sub-pixel layout maths must not put a caret on a row that reads as
    // fitting, because pressing it would move nothing.
    expect(
      usedByScrollState({ scrollLeft: 0, scrollWidth: 240, clientWidth: 240 }),
    ).toEqual({ canScrollLeft: false, canScrollRight: false });
    expect(
      usedByScrollState({
        scrollLeft: 0,
        scrollWidth: 240.5,
        clientWidth: 240,
      }),
    ).toEqual({ canScrollLeft: false, canScrollRight: false });
  });

  it("offers only the right caret at the start", () => {
    expect(usedByScrollState(AT_START)).toEqual({
      canScrollLeft: false,
      canScrollRight: true,
    });
  });

  it("offers both carets in the middle", () => {
    expect(usedByScrollState({ ...AT_START, scrollLeft: 300 })).toEqual({
      canScrollLeft: true,
      canScrollRight: true,
    });
  });

  it("offers only the left caret at the end", () => {
    // scrollWidth - clientWidth = 660: the far extent.
    expect(usedByScrollState({ ...AT_START, scrollLeft: 660 })).toEqual({
      canScrollLeft: true,
      canScrollRight: false,
    });
    // Browsers can report a fractional scrollLeft just shy of the extent.
    expect(usedByScrollState({ ...AT_START, scrollLeft: 659.4 })).toEqual({
      canScrollLeft: true,
      canScrollRight: false,
    });
  });
});

describe("usedByScrollStep", () => {
  it("pages by roughly one visible width, keeping an overlap", () => {
    expect(usedByScrollStep(240)).toBe(208);
    expect(usedByScrollStep(600)).toBe(568);
  });

  it("still advances usefully in a very narrow row", () => {
    // Without a floor, a 40px row would page by 8px, or backwards.
    expect(usedByScrollStep(40)).toBe(80);
  });
});

describe("scrollUsedBy", () => {
  it("scrolls the viewport one page in the pressed direction", () => {
    const scrollBy = vi.fn();
    scrollUsedBy({ clientWidth: 240, scrollBy }, 1, { reducedMotion: false });
    expect(scrollBy).toHaveBeenCalledWith({ left: 208, behavior: "smooth" });

    scrollUsedBy({ clientWidth: 240, scrollBy }, -1, { reducedMotion: false });
    expect(scrollBy).toHaveBeenLastCalledWith({
      left: -208,
      behavior: "smooth",
    });
  });

  it("jumps instead of animating when motion is reduced", () => {
    const scrollBy = vi.fn();
    scrollUsedBy({ clientWidth: 240, scrollBy }, 1, { reducedMotion: true });
    expect(scrollBy).toHaveBeenCalledWith({ left: 208, behavior: "auto" });
  });
});
