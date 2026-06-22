import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The config module reads from process.env at module load time, so each
// test imports a fresh copy via vi.resetModules() to exercise the
// resolution under a controlled env.

describe("bootstrap/config", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("BIND_HOST", () => {
    it("defaults to 127.0.0.1 when DBBOARD_BIND_HOST is unset", async () => {
      delete process.env.DBBOARD_BIND_HOST;
      const mod = await import("./config");
      expect(mod.BIND_HOST).toBe("127.0.0.1");
    });

    it("honours DBBOARD_BIND_HOST when set", async () => {
      process.env.DBBOARD_BIND_HOST = "0.0.0.0";
      const mod = await import("./config");
      expect(mod.BIND_HOST).toBe("0.0.0.0");
    });

    it("treats an empty DBBOARD_BIND_HOST as unset (falls back to 127.0.0.1)", async () => {
      process.env.DBBOARD_BIND_HOST = "";
      const mod = await import("./config");
      expect(mod.BIND_HOST).toBe("127.0.0.1");
    });
  });

  describe("API_SECRET", () => {
    it("is undefined when DBBOARD_API_SECRET is unset", async () => {
      delete process.env.DBBOARD_API_SECRET;
      const mod = await import("./config");
      expect(mod.API_SECRET).toBeUndefined();
    });

    it("normalises an empty DBBOARD_API_SECRET to undefined", async () => {
      process.env.DBBOARD_API_SECRET = "";
      const mod = await import("./config");
      expect(mod.API_SECRET).toBeUndefined();
    });

    it("returns the env value when DBBOARD_API_SECRET is non-empty", async () => {
      process.env.DBBOARD_API_SECRET = "abc123";
      const mod = await import("./config");
      expect(mod.API_SECRET).toBe("abc123");
    });
  });

  describe("assertSafeBindConfig", () => {
    it("allows 127.0.0.1 without a secret", async () => {
      const { assertSafeBindConfig } = await import("./config");
      expect(() =>
        assertSafeBindConfig({ bindHost: "127.0.0.1", apiSecret: undefined }),
      ).not.toThrow();
    });

    it("allows localhost without a secret", async () => {
      const { assertSafeBindConfig } = await import("./config");
      expect(() =>
        assertSafeBindConfig({ bindHost: "localhost", apiSecret: undefined }),
      ).not.toThrow();
    });

    it("allows ::1 (loopback IPv6) without a secret", async () => {
      const { assertSafeBindConfig } = await import("./config");
      expect(() => assertSafeBindConfig({ bindHost: "::1", apiSecret: undefined })).not.toThrow();
    });

    it("rejects 0.0.0.0 without a secret and names DBBOARD_API_SECRET", async () => {
      const { assertSafeBindConfig } = await import("./config");
      expect(() => assertSafeBindConfig({ bindHost: "0.0.0.0", apiSecret: undefined })).toThrow(
        /DBBOARD_API_SECRET/,
      );
    });

    it("rejects a LAN address without a secret", async () => {
      const { assertSafeBindConfig } = await import("./config");
      expect(() =>
        assertSafeBindConfig({ bindHost: "192.168.1.10", apiSecret: undefined }),
      ).toThrow(/DBBOARD_API_SECRET/);
    });

    it("allows 0.0.0.0 once a secret is configured", async () => {
      const { assertSafeBindConfig } = await import("./config");
      expect(() => assertSafeBindConfig({ bindHost: "0.0.0.0", apiSecret: "s" })).not.toThrow();
    });
  });
});
