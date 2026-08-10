import { describe, expect, it } from "vitest";
import {
  categoriseStatus,
  categoriseUpstream,
  normaliseStopReason,
  tokenCount,
} from "./ai-response-mapping";

// Shared by every adapter: the history record's vocabulary must not
// depend on which provider produced it, or two rows describing the same
// outcome would read differently.

describe("normaliseStopReason", () => {
  it("passes the canonical v:2 reasons through untouched", () => {
    for (const reason of ["end_turn", "max_tokens", "stop_sequence", "tool_use", "refusal"]) {
      expect(normaliseStopReason(reason)).toBe(reason);
    }
  });

  it("routes anything else through the other: hatch rather than dropping it", () => {
    expect(normaliseStopReason("pause_turn")).toBe("other:pause_turn");
  });

  it("reports nothing when the provider reported nothing", () => {
    expect(normaliseStopReason(null)).toBeNull();
    expect(normaliseStopReason(undefined)).toBeNull();
    expect(normaliseStopReason("")).toBeNull();
  });
});

describe("tokenCount", () => {
  it("keeps a finite number, zero included", () => {
    expect(tokenCount(0)).toBe(0);
    expect(tokenCount(42)).toBe(42);
  });

  it("never substitutes a zero for an absent count", () => {
    // In the log a fabricated count is indistinguishable from a measured
    // one, so "not reported" has to stay null.
    expect(tokenCount(null)).toBeNull();
    expect(tokenCount(undefined)).toBeNull();
    expect(tokenCount(Number.NaN)).toBeNull();
    expect(tokenCount(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("categoriseStatus", () => {
  it("blames the deployment for 401 and 403", () => {
    expect(categoriseStatus(401)).toBe("configuration");
    expect(categoriseStatus(403)).toBe("configuration");
  });

  it("blames the provider for every other status", () => {
    expect(categoriseStatus(400)).toBe("provider");
    expect(categoriseStatus(429)).toBe("provider");
    expect(categoriseStatus(500)).toBe("provider");
  });
});

describe("categoriseUpstream", () => {
  it("reads the status off a typed SDK error", () => {
    expect(categoriseUpstream(Object.assign(new Error("nope"), { status: 401 }))).toBe(
      "configuration",
    );
    expect(categoriseUpstream(Object.assign(new Error("nope"), { status: 503 }))).toBe("provider");
  });

  it("calls a failure with no status a network failure", () => {
    expect(categoriseUpstream(new Error("socket hang up"))).toBe("network");
    expect(categoriseUpstream(Object.assign(new Error("nope"), { status: "401" }))).toBe("network");
    expect(categoriseUpstream(undefined)).toBe("network");
  });
});
