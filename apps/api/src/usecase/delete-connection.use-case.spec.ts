import { describe, expect, it, vi } from "vitest";
import type { ConnectionRegistry } from "./connection-registry.port";
import { DeleteConnection } from "./delete-connection.use-case";

function registry(): ConnectionRegistry & { delete: ReturnType<typeof vi.fn> } {
  return {
    add: () => undefined,
    list: () => [],
    get: () => undefined,
    delete: vi.fn().mockReturnValue(true),
  };
}

describe("DeleteConnection", () => {
  it("forwards to registry.delete for a known id", () => {
    const r = registry();
    new DeleteConnection(r).execute("a");
    expect(r.delete).toHaveBeenCalledWith("a");
  });

  it("is idempotent — does not throw when the id is unknown", () => {
    const r = registry();
    r.delete = vi.fn().mockReturnValue(false);
    expect(() => new DeleteConnection(r).execute("missing")).not.toThrow();
  });
});
