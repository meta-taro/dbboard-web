import { describe, expect, it } from "vitest";

import { CapabilityError } from "../errors";
import {
  DEFAULT_MYSQL_PORT,
  DEFAULT_POSTGRES_PORT,
  forwardTarget,
  redirectToLoopback,
} from "./loopback";

describe("forwardTarget", () => {
  it("reads the endpoint out of a connection string", () => {
    expect(
      forwardTarget(
        { connectionString: "postgres://u:p@db.internal:5433/app" },
        DEFAULT_POSTGRES_PORT,
      ),
    ).toEqual({ host: "db.internal", port: 5433 });
  });

  it("falls back to the driver's default port when the URL omits one", () => {
    expect(
      forwardTarget({ connectionString: "postgres://db.internal/app" }, DEFAULT_POSTGRES_PORT),
    ).toEqual({ host: "db.internal", port: DEFAULT_POSTGRES_PORT });
    expect(
      forwardTarget({ connectionString: "mysql://db.internal/app" }, DEFAULT_MYSQL_PORT),
    ).toEqual({
      host: "db.internal",
      port: DEFAULT_MYSQL_PORT,
    });
  });

  it("reads the endpoint out of split host/port fields", () => {
    expect(forwardTarget({ host: "db.internal", port: 5433 }, DEFAULT_POSTGRES_PORT)).toEqual({
      host: "db.internal",
      port: 5433,
    });
    expect(forwardTarget({ host: "db.internal" }, DEFAULT_POSTGRES_PORT)).toEqual({
      host: "db.internal",
      port: DEFAULT_POSTGRES_PORT,
    });
  });

  it("prefers the connection string when a config carries both", () => {
    // pg parses the URL first and lets explicit fields override, so a config
    // with both is already ambiguous. Picking one and pinning it here beats
    // forwarding to one endpoint while the driver dials the other.
    expect(
      forwardTarget(
        { connectionString: "postgres://db.internal:5433/app", host: "elsewhere", port: 5555 },
        DEFAULT_POSTGRES_PORT,
      ),
    ).toEqual({ host: "db.internal", port: 5433 });
  });

  it("unwraps an IPv6 literal, which ssh2 wants bare", () => {
    expect(
      forwardTarget({ connectionString: "postgres://[fd00::1]:5433/app" }, DEFAULT_POSTGRES_PORT),
    ).toEqual({ host: "fd00::1", port: 5433 });
  });

  it("rejects a config that names no host at all", () => {
    expect(() => forwardTarget({}, DEFAULT_POSTGRES_PORT)).toThrow(CapabilityError);
    expect(() => forwardTarget({ connectionString: "   " }, DEFAULT_POSTGRES_PORT)).toThrow(
      CapabilityError,
    );
  });

  it("rejects a connection string it cannot parse", () => {
    expect(() => forwardTarget({ connectionString: "not a url" }, DEFAULT_POSTGRES_PORT)).toThrow(
      CapabilityError,
    );
  });

  it("rejects a connection string with no host component", () => {
    expect(() =>
      forwardTarget({ connectionString: "postgres:///app" }, DEFAULT_POSTGRES_PORT),
    ).toThrow(CapabilityError);
  });
});

describe("redirectToLoopback", () => {
  it("points the connection string at the local forward", () => {
    const config = { connectionString: "postgres://db.internal:5433/app" };
    expect(redirectToLoopback(config, 15432).connectionString).toBe(
      "postgres://127.0.0.1:15432/app",
    );
  });

  it("keeps userinfo, path and query intact", () => {
    const config = { connectionString: "postgres://user:p%40ss@db.internal:5433/app?ssl=true" };
    const rewritten = redirectToLoopback(config, 15432).connectionString;

    expect(rewritten).toContain("user:p%40ss@");
    expect(rewritten).toContain("/app?ssl=true");
    expect(rewritten).toContain("127.0.0.1:15432");
  });

  it("leaves no trace of the real host", () => {
    // Anything still naming the bastion's far side is a path the driver
    // could take around the tunnel.
    const config = { connectionString: "postgres://db.internal:5433/app" };
    expect(redirectToLoopback(config, 15432).connectionString).not.toContain("db.internal");
  });

  it("adds a port to a URL that had none", () => {
    const config = { connectionString: "mysql://db.internal/app" };
    expect(redirectToLoopback(config, 13306).connectionString).toBe("mysql://127.0.0.1:13306/app");
  });

  it("points split host/port fields at the local forward", () => {
    expect(redirectToLoopback({ host: "db.internal", port: 5433 }, 15432)).toEqual({
      host: "127.0.0.1",
      port: 15432,
    });
  });

  it("rewrites both when a config carries both", () => {
    const rewritten = redirectToLoopback(
      { connectionString: "postgres://db.internal:5433/app", host: "elsewhere", port: 5555 },
      15432,
    );

    expect(rewritten.host).toBe("127.0.0.1");
    expect(rewritten.port).toBe(15432);
    expect(rewritten.connectionString).not.toContain("db.internal");
  });

  it("carries every other field through untouched", () => {
    const config = { host: "db.internal", port: 5433, database: "app", user: "u", password: "p" };
    expect(redirectToLoopback(config, 15432)).toEqual({
      host: "127.0.0.1",
      port: 15432,
      database: "app",
      user: "u",
      password: "p",
    });
  });

  it("does not mutate the config it was handed", () => {
    const config = { connectionString: "postgres://db.internal:5433/app", host: "db.internal" };
    redirectToLoopback(config, 15432);

    expect(config.connectionString).toBe("postgres://db.internal:5433/app");
    expect(config.host).toBe("db.internal");
  });
});
