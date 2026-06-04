import { describe, expect, it } from "vitest";
import { CapabilityError } from "../domain/errors";
import { NullAdapter } from "./null-adapter";
import { StaticAdapterFactory } from "./static-adapter-factory";

describe("StaticAdapterFactory", () => {
  it("returns a NullAdapter for the 'null' driver", () => {
    expect(new StaticAdapterFactory().create("null")).toBeInstanceOf(NullAdapter);
  });

  it("raises CapabilityError for unknown drivers (404 at the HTTP layer)", () => {
    expect(() => new StaticAdapterFactory().create("postgres")).toThrowError(CapabilityError);
    expect(() => new StaticAdapterFactory().create("")).toThrowError(CapabilityError);
  });
});
