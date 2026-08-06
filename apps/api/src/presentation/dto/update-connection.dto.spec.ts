import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { UpdateConnectionDto } from "./update-connection.dto";

function validate(payload: unknown) {
  const dto = plainToInstance(UpdateConnectionDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: false }) };
}

describe("UpdateConnectionDto", () => {
  it("accepts a rename on its own", () => {
    const { dto, errors } = validate({ label: "Staging" });
    expect(errors).toHaveLength(0);
    expect(dto).toEqual({ label: "Staging" });
  });

  it("accepts an empty body — PATCH may say nothing", () => {
    expect(validate({}).errors).toHaveLength(0);
  });

  it("accepts a blank password, because blank means keep", () => {
    // The difference from RegisterConnectionDto that matters. A form that
    // round-trips its inputs sends "" for the box nobody typed in, and
    // rejecting it here would make every save fail unless the user retyped
    // the credential (ADR-0080).
    const { dto, errors } = validate({ host: "new.host", password: "" });
    expect(errors).toHaveLength(0);
    expect(dto.password).toBe("");
  });

  it("accepts a blank auth token on the same terms as a blank password", () => {
    // A Turso edit form has the same round-trip problem: the token box is
    // never prefilled, so it submits "". Rejecting it would make renaming a
    // Turso connection impossible without pasting the token again.
    const { dto, errors } = validate({ connectionString: "libsql://new.turso.io", authToken: "" });
    expect(errors).toHaveLength(0);
    expect(dto.authToken).toBe("");
  });

  it("rejects a blank label", () => {
    // Blank means "keep" for a password and "unfindable" for a name. A
    // connection with no label cannot be picked out of the sidebar.
    expect(validate({ label: "" }).errors.map((e) => e.property)).toContain("label");
  });

  it("drops a driver that tries to come along", () => {
    // Not declared, so the global `whitelist: true` pipe strips it. The
    // driver is fixed at registration — this is the door that keeps an edit
    // from changing what a connection is while keeping its id and name.
    const { dto } = validate({ label: "Prod", driver: "mysql" });
    expect(dto).not.toHaveProperty("driver");
  });

  it("applies the same field rules as registration", () => {
    expect(validate({ port: 0 }).errors.map((e) => e.property)).toContain("port");
    expect(validate({ port: 70000 }).errors.map((e) => e.property)).toContain("port");
    expect(validate({ sslMode: "prefer" }).errors.map((e) => e.property)).toContain("sslMode");
    expect(validate({ sslMode: "verify-full" }).errors.map((e) => e.property)).toContain("sslMode");
    expect(validate({ sslMode: "require" }).errors).toHaveLength(0);
    expect(validate({ sslMode: "disable" }).errors).toHaveLength(0);
  });
});
