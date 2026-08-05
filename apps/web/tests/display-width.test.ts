import { describe, expect, it } from "vitest";
import { displayWidth, needsWideEditor, INLINE_EDITOR_COLUMNS } from "../app/utils/display-width";

// The threshold is imported rather than written out, so these assert
// behaviour at the boundary instead of restating a number that the module
// is free to retune (desktop ADR-0082 § Consequences).
const ascii = (n: number) => "a".repeat(n);
const cjk = (n: number) => "日".repeat(n); // 日

describe("displayWidth", () => {
  it("counts an empty string as zero", () => {
    expect(displayWidth("")).toBe(0);
  });

  it("counts ASCII as one column per character", () => {
    expect(displayWidth("hello")).toBe(5);
  });

  it("counts accented Latin as one column — it is not full-width", () => {
    expect(displayWidth("café")).toBe(4);
    expect(displayWidth("größer")).toBe(6);
  });

  it("counts CJK as the two columns it occupies", () => {
    expect(displayWidth("日本語")).toBe(6);
  });

  it("counts kana as two columns", () => {
    expect(displayWidth("ひらがな")).toBe(8);
    expect(displayWidth("カタカナ")).toBe(8);
  });

  it("counts Hangul as two columns", () => {
    expect(displayWidth("한국어")).toBe(6);
  });

  it("counts full-width Latin forms as two columns", () => {
    expect(displayWidth("ＡＢＣ")).toBe(6);
  });

  // The reason iteration is by code point and not by UTF-16 unit: an emoji
  // is two units, and counting units would score it 4.
  it("counts an emoji as two columns, not four", () => {
    expect(displayWidth("🎉")).toBe(2);
    expect("🎉".length).toBe(2);
  });

  it("counts an astral CJK extension character once, at two columns", () => {
    // U+20000, CJK ext B — a surrogate pair like the emoji, but outside the
    // emoji planes, so it exercises the other astral range.
    expect(displayWidth("\u{20000}")).toBe(2);
  });

  it("adds mixed scripts together", () => {
    // "id: " is 4, 日本 is 2 x 2.
    expect(displayWidth("id: 日本")).toBe(8);
  });
});

describe("needsWideEditor", () => {
  it("leaves a value that fits alone", () => {
    expect(needsWideEditor(ascii(INLINE_EDITOR_COLUMNS))).toBe(false);
  });

  it("opens one column past the threshold", () => {
    expect(needsWideEditor(ascii(INLINE_EDITOR_COLUMNS + 1))).toBe(true);
  });

  // The defect ADR-0082 names: measured by `.length`, this text is half the
  // threshold and would never offer a viewer, while on screen it has been
  // truncated for twenty characters already.
  it("reaches the threshold at half the character count in Japanese", () => {
    const half = INLINE_EDITOR_COLUMNS / 2;
    expect(needsWideEditor(cjk(half))).toBe(false);
    expect(needsWideEditor(cjk(half + 1))).toBe(true);
    expect(cjk(half + 1).length).toBeLessThan(INLINE_EDITOR_COLUMNS);
  });

  it("opens for any value containing a newline, however short", () => {
    expect(needsWideEditor("a\nb")).toBe(true);
    expect(needsWideEditor("\n")).toBe(true);
  });

  it("opens for a CRLF value — the LF is what it tests", () => {
    expect(needsWideEditor("a\r\nb")).toBe(true);
  });

  it("leaves an empty value alone", () => {
    expect(needsWideEditor("")).toBe(false);
  });
});
