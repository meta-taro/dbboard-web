import { describe, expect, it } from "vitest";
import { defaultPortFor } from "../app/utils/default-port";

// The page test proves a blank box reaches `register` as 5432. These pin
// the table itself, so adding a driver in rung 7 has somewhere obvious to
// fail if its default is forgotten.
describe("defaultPortFor", () => {
  it("gives postgres its well-known port", () => {
    expect(defaultPortFor("postgres")).toBe(5432);
  });

  it("gives the null driver none, because it connects to nothing", () => {
    // Not 0 and not -1: the form omits the field entirely for this driver,
    // and `undefined` is the only answer that survives being put in a
    // payload without meaning something.
    expect(defaultPortFor("null")).toBeUndefined();
  });
});
