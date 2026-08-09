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

  // ---- 0031 slice D: the bastion in front of the connection -----------

  const SSH = {
    host: "bastion.example.com",
    port: 2222,
    user: "jump",
    password: "pw",
    fingerprint: `SHA256:${"A".repeat(43)}`,
  };

  it("accepts a connection fronted by an ssh tunnel, and keeps the block", () => {
    // The whitelist trap the turso case describes, in its worst form. An
    // undeclared `ssh` is stripped before the factory ever sees it, so the
    // connection registers — successfully, with no error to read — going
    // straight at the database the operator was tunnelling to reach.
    const { dto, errors } = validate({
      label: "Prod",
      driver: "postgres",
      host: "db.internal",
      ssh: SSH,
    });
    expect(errors).toHaveLength(0);
    expect(dto.ssh).toEqual(SSH);
  });

  it("accepts key material and a known_hosts text as the other half of each pair", () => {
    // The web shape takes material, not paths (see `SshTunnelConfig`): a
    // path field would let a request make the API process read files off
    // the server. Both alternatives have to be declared or the form can
    // only ever send the password/fingerprint pair.
    const { dto, errors } = validate({
      label: "Prod",
      driver: "postgres",
      host: "db.internal",
      ssh: {
        host: "bastion.example.com",
        user: "jump",
        privateKey: "pem-key-material",
        passphrase: "unlock",
        knownHosts: "bastion.example.com ssh-ed25519 AAAA",
      },
    });
    expect(errors).toHaveLength(0);
    expect(dto.ssh).toMatchObject({
      privateKey: "pem-key-material",
      knownHosts: expect.any(String),
    });
  });

  it("strips a field the ssh block does not declare", () => {
    // `privateKeyPath` is the field this shape deliberately does not have.
    // The domain ignores it by reading only the names it knows; the pipe has
    // to drop it at the door too, which only happens if the block is
    // validated as a nested class rather than waved through as an object.
    const { dto, errors } = validate({
      label: "Prod",
      driver: "postgres",
      host: "db.internal",
      ssh: { ...SSH, privateKeyPath: "/root/.ssh/id_rsa" },
    });
    expect(errors).toHaveLength(0);
    expect(dto.ssh).not.toHaveProperty("privateKeyPath");
  });

  it("rejects an ssh block that names no host or no user", () => {
    // Not a cross-field rule — `resolveSshTunnelConfig` owns those, and
    // answers 404. A block with no host is malformed at the shape level,
    // and 422 is the honest status for that.
    for (const ssh of [
      { ...SSH, host: undefined },
      { ...SSH, user: "" },
    ]) {
      const { errors } = validate({ label: "x", driver: "postgres", host: "h", ssh });
      expect(errors.map((e) => e.property)).toContain("ssh");
    }
  });

  it("rejects an ssh port out of TCP range", () => {
    const { errors } = validate({
      label: "x",
      driver: "postgres",
      host: "h",
      ssh: { ...SSH, port: 70000 },
    });
    expect(errors.map((e) => e.property)).toContain("ssh");
  });

  it("leaves ssh absent when it is not sent", () => {
    const { dto, errors } = validate({ label: "x", driver: "postgres", host: "h" });
    expect(errors).toHaveLength(0);
    expect(dto.ssh).toBeUndefined();
  });
});
