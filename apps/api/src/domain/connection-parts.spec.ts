import { describe, expect, it } from "vitest";
import { connectionPartsOf } from "./connection-parts";

describe("connectionPartsOf", () => {
  it("keeps the split fields it is given", () => {
    expect(
      connectionPartsOf({
        host: "db.internal",
        port: 5432,
        database: "app",
        user: "reader",
        sslMode: "require",
      }),
    ).toEqual({
      host: "db.internal",
      port: 5432,
      database: "app",
      user: "reader",
      sslMode: "require",
    });
  });

  it("has nowhere to put a password, even when handed one", () => {
    // The point of the type (desktop ADR-0080). A prefill payload built from
    // this cannot leak a credential by oversight, because the shape has no
    // member to leak it into — the caller passing one is not enough.
    const parts = connectionPartsOf({
      host: "db.internal",
      user: "reader",
      password: "SECRET-PW",
    } as Parameters<typeof connectionPartsOf>[0]);

    expect(parts).not.toHaveProperty("password");
    expect(JSON.stringify(parts)).not.toContain("SECRET");
  });

  it("reads the non-secret half out of a pasted URL and discards the rest", () => {
    const parts = connectionPartsOf({
      connectionString: "postgresql://reader:SECRET-PW@db.internal:6543/app",
    });

    expect(parts).toEqual({
      host: "db.internal",
      port: 6543,
      database: "app",
      user: "reader",
    });
    expect(JSON.stringify(parts)).not.toContain("SECRET");
  });

  it("decodes percent-escapes in the user and database it recovers", () => {
    // What comes back has to be what the user would type into the boxes, not
    // the URL spelling of it — a prefilled `my%20db` is a different database.
    expect(
      connectionPartsOf({ connectionString: "postgresql://a%40b@host/my%20db" }),
    ).toMatchObject({ user: "a@b", database: "my db" });
  });

  it("unwraps an IPv6 host from its URL brackets", () => {
    // `URL.hostname` keeps the brackets; a host box wants the address.
    expect(connectionPartsOf({ connectionString: "postgresql://[::1]:5432/app" })).toMatchObject({
      host: "::1",
    });
  });

  it("reports the mode the connection will actually use, not the one typed", () => {
    // `prefer` means "try TLS, accept plaintext", which slice A removed as an
    // outcome. Echoing it back would prefill a select with a mode the adapter
    // does not implement.
    expect(
      connectionPartsOf({ connectionString: "postgresql://host/app?sslmode=prefer" }),
    ).toMatchObject({ sslMode: "require" });
    expect(
      connectionPartsOf({ connectionString: "postgresql://host/app?sslmode=disable" }),
    ).toMatchObject({ sslMode: "disable" });
  });

  it("lets an explicit sslMode outrank the one in the URL", () => {
    // Mirrors `resolvePostgresPoolOptions`, which resolves the same conflict
    // the same way. Parts that disagreed with the pool options would describe
    // a connection nobody made.
    expect(
      connectionPartsOf({
        connectionString: "postgresql://host/app?sslmode=disable",
        sslMode: "require",
      }),
    ).toMatchObject({ sslMode: "require" });
  });

  it("lets the URL win over split fields, as the resolver does", () => {
    // `resolvePostgresPoolOptions` ignores host/port/database/user entirely
    // once a connectionString is present (libpq's precedence). Parts follow,
    // because they describe the connection that exists.
    expect(
      connectionPartsOf({
        connectionString: "postgresql://url-user@url-host/url-db",
        host: "field-host",
        database: "field-db",
        user: "field-user",
      }),
    ).toEqual({ host: "url-host", database: "url-db", user: "url-user" });
  });

  it("reports nothing when there is nothing non-secret to report", () => {
    // The `null` driver's case: it connects to no host, so an empty parts
    // object would be a claim about a connection that has no address.
    expect(connectionPartsOf({})).toBeUndefined();
  });

  it("reports nothing rather than throwing on a connection string it cannot parse", () => {
    // A driver that ignores `connectionString` still reaches here. Registration
    // must not 500 on a field the chosen adapter never looked at.
    expect(connectionPartsOf({ connectionString: "not a url" })).toBeUndefined();
    expect(connectionPartsOf({ connectionString: "postgresql://host/%zz" })).toMatchObject({
      host: "host",
    });
  });

  it("omits a port the URL did not state rather than inventing the default", () => {
    // 5432 is what the *form* fills in for a blank box (ADR-0073 decision 3).
    // Putting it here would report a port the connection never named.
    expect(connectionPartsOf({ connectionString: "postgresql://host/app" })).toEqual({
      host: "host",
      database: "app",
    });
  });
});
