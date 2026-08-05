import { describe, expect, it } from "vitest";
import { hardenSslMode, readSslModeFromUrl, SSL_MODES } from "../app/utils/ssl-mode";

// The API hardens too, and the API is the one that decides. This copy
// exists so the select can show what will actually happen rather than what
// the URL text says — if the two ever disagree, the API is right and this
// is the bug.
describe("hardenSslMode", () => {
  it("treats only 'disable' as an opt-out", () => {
    expect(hardenSslMode("disable")).toBe("disable");
  });

  it("requires TLS for everything else, including the plaintext-preferring modes", () => {
    expect(hardenSslMode("prefer")).toBe("require");
    expect(hardenSslMode("allow")).toBe("require");
    expect(hardenSslMode("verify-full")).toBe("require");
    expect(hardenSslMode("DISABLE")).toBe("require");
    expect(hardenSslMode("")).toBe("require");
  });

  it("offers exactly the modes the API accepts as a field", () => {
    expect([...SSL_MODES]).toEqual(["require", "disable"]);
  });
});

describe("readSslModeFromUrl", () => {
  it("reads an explicit opt-out out of a pasted URL", () => {
    expect(readSslModeFromUrl("postgres://u:p@host:5432/db?sslmode=disable")).toBe("disable");
  });

  it("reports what a stated mode will actually do, not what it says", () => {
    // `prefer` reads as "TLS if available, plaintext otherwise" and the API
    // rewrites it up. A select showing Disabled here would be describing a
    // connection that will in fact be encrypted.
    expect(readSslModeFromUrl("postgres://host/db?sslmode=prefer")).toBe("require");
    expect(readSslModeFromUrl("postgres://host/db?sslmode=verify-full")).toBe("require");
  });

  it("says nothing when the URL says nothing", () => {
    // Distinct from "require": a URL with no opinion must not overwrite a
    // choice the user made in the select.
    expect(readSslModeFromUrl("postgres://host/db")).toBeUndefined();
    expect(readSslModeFromUrl("postgres://host/db?application_name=x")).toBeUndefined();
  });

  it("says nothing about text that is not a URL yet", () => {
    // The field is read on every keystroke, so most of what it sees is a
    // half-typed URL. That is not an error state.
    expect(readSslModeFromUrl("")).toBeUndefined();
    expect(readSslModeFromUrl("postgres://")).toBeUndefined();
    expect(readSslModeFromUrl("not a url at all")).toBeUndefined();
  });
});
