import { describe, expect, it } from "vitest";
import { CapabilityError } from "../domain/errors";
import type { AdapterFactory } from "./adapter-factory.port";
import { ListDrivers } from "./list-drivers.use-case";

function factory(drivers: readonly string[]): AdapterFactory {
  return {
    create: () => {
      throw new CapabilityError("not needed here");
    },
    supported: () => drivers,
  };
}

describe("ListDrivers", () => {
  it("reports what the factory supports, in the factory's order", () => {
    // Order carries meaning downstream — the form defaults to the first
    // option — so it is preserved rather than sorted into something tidier.
    expect(new ListDrivers(factory(["postgres", "null"])).execute()).toEqual({
      drivers: ["postgres", "null"],
    });
  });

  it("passes a grown list through without knowing what grew", () => {
    // The point of the route: adding a driver to the factory reaches the
    // form with no edit here and none in the template.
    expect(new ListDrivers(factory(["postgres", "mysql", "null"])).execute()).toEqual({
      drivers: ["postgres", "mysql", "null"],
    });
  });

  it("returns a plain array the caller cannot use to edit the factory's list", () => {
    const drivers = ["postgres", "null"];
    const out = new ListDrivers(factory(drivers)).execute();
    out.drivers.push("mongo");
    expect(drivers).toEqual(["postgres", "null"]);
  });
});
