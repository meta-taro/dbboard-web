import { describe, expect, it } from "vitest";
import { defaultPortFor, supportsSshTunnel } from "../app/utils/default-port";

// The page test proves a blank box reaches `register` as 5432. These pin
// the table itself, so adding a driver in rung 7 has somewhere obvious to
// fail if its default is forgotten.
describe("defaultPortFor", () => {
  it("gives postgres its well-known port", () => {
    expect(defaultPortFor("postgres")).toBe(5432);
  });

  it("gives mysql its well-known port", () => {
    // Owed since slice C shipped the adapter. `mysql2` defaults to 3306
    // itself, so the payload was never wrong — but the box showed no
    // placeholder, which is the form declining to say what it is about to
    // send.
    expect(defaultPortFor("mysql")).toBe(3306);
  });

  it("gives the null driver none, because it connects to nothing", () => {
    // Not 0 and not -1: the form omits the field entirely for this driver,
    // and `undefined` is the only answer that survives being put in a
    // payload without meaning something.
    expect(defaultPortFor("null")).toBeUndefined();
  });
});

describe("supportsSshTunnel", () => {
  // Deliberately reads the same table rather than keeping a list beside it.
  // `StaticAdapterFactory` reaches the answer the same way — a `defaultPort`
  // on the builder is what makes a driver tunnel-capable — because a forward
  // redirects a `host:port` pair, so a driver that cannot say which port it
  // speaks on has nothing to redirect.
  it("offers a tunnel to the drivers that speak on a port", () => {
    expect(supportsSshTunnel("postgres")).toBe(true);
    expect(supportsSshTunnel("mysql")).toBe(true);
  });

  it("refuses one to the drivers that do not", () => {
    // Turso is a libSQL URL and D1 is an HTTPS API; `null` connects to
    // nothing. The API answers a block on any of them with a 404, so
    // offering the boxes would be offering a connection it will refuse.
    expect(supportsSshTunnel("turso")).toBe(false);
    expect(supportsSshTunnel("d1")).toBe(false);
    expect(supportsSshTunnel("null")).toBe(false);
  });

  it("refuses one to a driver it has never heard of", () => {
    // The server can offer a driver this build has no row for (slice E).
    // Hiding the section is the conservative reading: the worst case is a
    // tunnel-capable driver whose boxes appear a release late, where the
    // other direction is a form that collects a bastion and a private key
    // and posts them at a 404.
    expect(supportsSshTunnel("cockroach")).toBe(false);
  });
});
