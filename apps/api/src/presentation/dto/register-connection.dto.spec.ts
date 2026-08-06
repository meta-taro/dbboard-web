import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { RegisterConnectionDto } from "./register-connection.dto";

function validate(payload: unknown) {
  const dto = plainToInstance(RegisterConnectionDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: false }) };
}

describe("RegisterConnectionDto", () => {
  it("accepts a well-formed { label, driver } body", () => {
    const { dto, errors } = validate({ label: "Local null", driver: "null" });
    expect(errors).toHaveLength(0);
    expect(dto).toEqual({ label: "Local null", driver: "null" });
  });

  it("rejects when label is missing", () => {
    const { errors } = validate({ driver: "null" });
    expect(errors.map((e) => e.property)).toContain("label");
  });

  it("rejects when driver is missing", () => {
    const { errors } = validate({ label: "x" });
    expect(errors.map((e) => e.property)).toContain("driver");
  });

  it("accepts a postgres body with a connectionString", () => {
    const { dto, errors } = validate({
      label: "Prod",
      driver: "postgres",
      connectionString: "postgresql://u:p@host:5432/db",
    });
    expect(errors).toHaveLength(0);
    expect(dto.connectionString).toBe("postgresql://u:p@host:5432/db");
  });

  it("accepts a postgres body with split fields", () => {
    const { dto, errors } = validate({
      label: "Local",
      driver: "postgres",
      host: "localhost",
      port: 5432,
      database: "app",
      user: "u",
      password: "p",
    });
    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({
      host: "localhost",
      port: 5432,
      database: "app",
      user: "u",
      password: "p",
    });
  });

  it("accepts a turso body with an auth token", () => {
    // Without the field declared, the global `whitelist: true` pipe strips
    // it and the connection registers unauthenticated — a 401 on the first
    // query, with nothing in the request to explain it.
    const { dto, errors } = validate({
      label: "Turso",
      driver: "turso",
      connectionString: "libsql://db-org.turso.io",
      authToken: "eyJhbGciOi",
    });
    expect(errors).toHaveLength(0);
    expect(dto.authToken).toBe("eyJhbGciOi");
  });

  it("accepts a d1 body with both path ids and a token", () => {
    // The same whitelist trap the turso case describes, twice over: with
    // `accountId` and `databaseId` stripped, `createD1Adapter` sees a config
    // missing its required fields and the registration 404s — for a body
    // that named them both.
    const { dto, errors } = validate({
      label: "D1",
      driver: "d1",
      accountId: "a1b2c3",
      databaseId: "d4e5f6",
      authToken: "cf-token",
    });
    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({ accountId: "a1b2c3", databaseId: "d4e5f6", authToken: "cf-token" });
  });

  it("rejects port out of TCP range", () => {
    const { errors } = validate({ label: "x", driver: "postgres", host: "h", port: 70000 });
    expect(errors.map((e) => e.property)).toContain("port");
  });

  it("rejects non-string connectionString", () => {
    const { errors } = validate({ label: "x", driver: "postgres", connectionString: 42 });
    expect(errors.map((e) => e.property)).toContain("connectionString");
  });

  // ---- 0027 slice B: the TLS choice on the wire ----------------------

  it("accepts the two TLS modes the form can express", () => {
    for (const sslMode of ["require", "disable"] as const) {
      const { dto, errors } = validate({ label: "x", driver: "postgres", host: "h", sslMode });
      expect(errors).toHaveLength(0);
      expect(dto.sslMode).toBe(sslMode);
    }
  });

  it("rejects sslMode=prefer, which the URL path merely hardens", () => {
    // The two paths treat `prefer` differently on purpose. Inside a pasted
    // connectionString it is text the user did not necessarily write, so
    // the resolver rewrites it up to `require` and says nothing. As a
    // field it is a claim about which option the form's TLS select was
    // on — and the select has no such option, so the only thing that can
    // send it is a client that has drifted from the API. Hardening that
    // silently would hide the drift.
    const { errors } = validate({
      label: "x",
      driver: "postgres",
      host: "h",
      sslMode: "prefer",
    });
    expect(errors.map((e) => e.property)).toContain("sslMode");
  });

  it("rejects TLS modes it cannot honour rather than approximating them", () => {
    // `verify-ca` and `verify-full` are stricter than `require`, and there
    // is nowhere to accept the CA they need. Accepting them and resolving
    // down to `require` would promise verification this API does not do.
    for (const sslMode of ["verify-ca", "verify-full", "allow", "REQUIRE", ""]) {
      const { errors } = validate({ label: "x", driver: "postgres", host: "h", sslMode });
      expect(errors.map((e) => e.property)).toContain("sslMode");
    }
  });

  it("leaves sslMode absent when it is not sent, so the resolver's default applies", () => {
    const { dto, errors } = validate({ label: "x", driver: "postgres", host: "h" });
    expect(errors).toHaveLength(0);
    expect(dto.sslMode).toBeUndefined();
  });
});
