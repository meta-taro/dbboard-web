import { describe, expect, it } from "vitest";
import { compareEnvelopes, normalizeContentType } from "./compare";

// Lives inside the conformance config so `pnpm conformance` exercises
// the diff helper even when the desktop binary isn't available — that
// way the substring / ignore-keys logic stays honest without forcing
// the maintainer to keep a Rust toolchain on every dev box.

describe("normalizeContentType", () => {
  it("strips charset suffix", () => {
    expect(normalizeContentType("application/json; charset=utf-8")).toBe("application/json");
  });

  it("lowercases the media type", () => {
    expect(normalizeContentType("TEXT/Plain")).toBe("text/plain");
  });

  it("treats undefined as empty", () => {
    expect(normalizeContentType(undefined)).toBe("");
  });
});

describe("compareEnvelopes", () => {
  const json = (status: number, body: unknown): Parameters<typeof compareEnvelopes>[0] => ({
    status,
    contentType: "application/json; charset=utf-8",
    body,
    text: JSON.stringify(body),
  });
  const plain = (status: number, text: string): Parameters<typeof compareEnvelopes>[0] => ({
    status,
    contentType: "text/plain; charset=utf-8",
    body: {},
    text,
  });

  it("returns null when JSON bodies match exactly", () => {
    expect(compareEnvelopes(json(200, { status: "ok" }), json(200, { status: "ok" }))).toBeNull();
  });

  it("flags differing status codes", () => {
    const msg = compareEnvelopes(json(200, {}), json(500, {}));
    expect(msg).toMatch(/status mismatch/);
  });

  it("flags differing content types", () => {
    const msg = compareEnvelopes(json(200, {}), plain(200, ""));
    expect(msg).toMatch(/content-type mismatch/);
  });

  it("ignores top-level keys when asked (capabilities.id carve-out)", () => {
    const desktop = json(200, { id: "postgres", capabilities: { has_views: false } });
    const web = json(200, { id: "null", capabilities: { has_views: false } });
    expect(compareEnvelopes(desktop, web, { ignoreTopLevelKeys: ["id"] })).toBeNull();
  });

  it("still flags nested diffs even when a top-level key is ignored", () => {
    const desktop = json(200, { id: "postgres", capabilities: { has_views: true } });
    const web = json(200, { id: "null", capabilities: { has_views: false } });
    const msg = compareEnvelopes(desktop, web, { ignoreTopLevelKeys: ["id"] });
    expect(msg).toMatch(/JSON body mismatch/);
  });

  it("flags JSON bodies that differ in array order", () => {
    const msg = compareEnvelopes(json(200, [1, 2]), json(200, [2, 1]));
    expect(msg).toMatch(/JSON body mismatch/);
  });

  it("passes case-insensitive plain-text token matches", () => {
    const desktop = plain(413, "Payload Too Large — request body exceeds the 64 KiB cap");
    const web = plain(413, "Payload too LARGE: maximum body size is 64 KiB");
    expect(
      compareEnvelopes(desktop, web, { plainTextTokens: ["Payload Too Large", "64 KiB"] }),
    ).toBeNull();
  });

  it("flags plain-text bodies missing a required token", () => {
    const desktop = plain(413, "Payload Too Large — request body exceeds the 64 KiB cap");
    const web = plain(413, "the body is too big");
    const msg = compareEnvelopes(desktop, web, { plainTextTokens: ["64 KiB"] });
    expect(msg).toMatch(/missing token/);
  });
});
