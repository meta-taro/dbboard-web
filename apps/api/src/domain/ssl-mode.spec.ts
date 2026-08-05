import { describe, expect, it } from "vitest";
import { hardenSslMode, SSL_MODES } from "./ssl-mode";

// The resolver has its own tests for how this behaves inside a URL and
// inside a set of split fields. These pin the rule itself, one input class
// per case, so a future adapter that calls `hardenSslMode` directly
// inherits a stated contract rather than the Postgres path's incidentals.
describe("hardenSslMode", () => {
  it("treats only 'disable' as an opt-out", () => {
    expect(hardenSslMode("disable")).toBe("disable");
  });

  it("requires TLS when nothing was supplied", () => {
    // The default has to be the safe one, not the permissive one. This is
    // the case that was wrong before 0027 slice A.
    expect(hardenSslMode(undefined)).toBe("require");
    // `null` is what URLSearchParams.get returns for an absent parameter,
    // so it reaches here on the connectionString path without a guard.
    expect(hardenSslMode(null)).toBe("require");
  });

  it("rewrites 'prefer' up rather than honouring the plaintext fallback", () => {
    expect(hardenSslMode("prefer")).toBe("require");
  });

  it("resolves stricter modes down to what it can actually deliver", () => {
    // Not a silent downgrade of intent — the caller asked for more
    // protection than `require` and gets `require`, which is as far as
    // this API can go without a CA. The DTO refuses these outright when
    // they arrive as a field; inside a pasted URL there is no one to
    // refuse, so the safest reachable mode is the answer.
    expect(hardenSslMode("verify-ca")).toBe("require");
    expect(hardenSslMode("verify-full")).toBe("require");
  });

  it("does not let an unrecognised mode fall through to plaintext", () => {
    // Including the near-misses. A typo must fail closed, and `allow` is
    // libpq's other plaintext-preferring mode — spelling it correctly
    // should not be a way around the rule.
    expect(hardenSslMode("allow")).toBe("require");
    expect(hardenSslMode("disabled")).toBe("require");
    expect(hardenSslMode("DISABLE")).toBe("require");
    expect(hardenSslMode("")).toBe("require");
  });

  it("offers exactly the modes it can honour", () => {
    // The DTO validates against this array, so widening it silently
    // widens the wire. Pinned so that adding a value is a deliberate edit
    // with a failing test attached.
    expect([...SSL_MODES]).toEqual(["require", "disable"]);
  });
});
