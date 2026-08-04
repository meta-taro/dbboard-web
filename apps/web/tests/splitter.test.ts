import { describe, expect, it } from "vitest";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  parseSidebarWidth,
} from "../app/utils/splitter";

describe("clampSidebarWidth", () => {
  it("leaves a width that is already legal alone", () => {
    expect(clampSidebarWidth(320, 1440)).toBe(320);
  });

  it("raises a width below the minimum", () => {
    expect(clampSidebarWidth(40, 1440)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("lowers a width above the maximum", () => {
    expect(clampSidebarWidth(2000, 4000)).toBe(SIDEBAR_MAX_WIDTH);
  });

  // The grid is the point of the app; a sidebar taking most of a laptop
  // window would leave nothing to read the results in.
  it("never lets the sidebar take more than half the window", () => {
    expect(clampSidebarWidth(600, 900)).toBe(450);
  });

  // ADR-0083 decision 4. On a window too narrow for both panes a cramped
  // sidebar beats an unreadable one, and the grid can still scroll.
  it("keeps the minimum even when half the window is less than that", () => {
    expect(clampSidebarWidth(300, 200)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("applies only the absolute bounds when the viewport is unknown", () => {
    expect(clampSidebarWidth(500)).toBe(500);
    expect(clampSidebarWidth(5000)).toBe(SIDEBAR_MAX_WIDTH);
  });

  // A `NaN` reaches here from `Number("abc")` and from a rect measured
  // before layout. Neither is a width, and neither should wedge the divider.
  it("falls back to the default for a width that is not a number", () => {
    expect(clampSidebarWidth(Number.NaN, 1440)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, 1440)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("returns whole pixels", () => {
    expect(clampSidebarWidth(320.4, 1440)).toBe(320);
    expect(clampSidebarWidth(320.6, 1440)).toBe(321);
  });
});

describe("parseSidebarWidth", () => {
  it("reads a stored number back", () => {
    expect(parseSidebarWidth("320")).toBe(320);
  });

  // Not clamped against a viewport here: ADR-0083 decision 3 keeps the
  // *chosen* width intact so widening the window restores it. Only the
  // absolute bounds apply, and those are what the user could have picked.
  it("holds a stored width the current window cannot honour", () => {
    expect(parseSidebarWidth("600")).toBe(600);
  });

  it("clamps a stored width outside the absolute bounds", () => {
    expect(parseSidebarWidth("9999")).toBe(SIDEBAR_MAX_WIDTH);
    expect(parseSidebarWidth("1")).toBe(SIDEBAR_MIN_WIDTH);
  });

  // Anything else on the origin can write this key, and the value is absent
  // during SSR. Ticket 0025 invariant 6: none of it may block the render.
  it("falls back to the default for anything that is not a stored width", () => {
    for (const raw of [null, undefined, "", "   ", "abc", "NaN", {}, [], true]) {
      expect(parseSidebarWidth(raw)).toBe(SIDEBAR_DEFAULT_WIDTH);
    }
  });

  it("accepts a number as readily as its string form", () => {
    expect(parseSidebarWidth(320)).toBe(320);
  });
});
