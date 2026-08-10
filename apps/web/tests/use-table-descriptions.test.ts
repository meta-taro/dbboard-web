import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { apiFetch } from "../app/composables/internal/http";
import { useTableDescriptions } from "../app/composables/useTableDescriptions";
import type { TableInfo } from "../app/composables/useSchemaBrowser";

// Ticket 0032 slice E — the prefetch behind the AI panel's "include
// column details" box (desktop ADR-0028 Decision 9). Fans
// `GET /connections/:id/table-schema` out over the table list, bounded,
// and reports how many tables it could not describe so the panel can say
// so without blocking the Suggest.

vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

type DescribeApi = ReturnType<typeof useTableDescriptions>;

function makeHarness(connectionId = "abc", apiBase = "http://test") {
  const holder: { api: DescribeApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useTableDescriptions(connectionId, { apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

function described(name: string, schema: string | null = "public") {
  return {
    table: { schema, name },
    columns: [
      {
        name: "id",
        declared_type: "integer",
        nullable: false,
        primary_key: true,
        ordinal: 1,
        default_value: null,
      },
    ],
    primary_key: ["id"],
  };
}

/** Answers every describe call with that table's own description. */
function answerDescribes() {
  mockFetch.mockImplementation((url: string) => {
    const query = url.slice(url.indexOf("?") + 1);
    const params = new URLSearchParams(query);
    return Promise.resolve(described(params.get("table") ?? "?", params.get("schema")));
  });
}

describe("useTableDescriptions", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("capability probe", () => {
    it("reports supported once the connection says it can describe tables", async () => {
      mockFetch.mockResolvedValueOnce({
        id: "abc",
        capabilities: { has_describe_table: true },
      });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      // False until the answer lands: the box must not offer something we
      // have not been told is there.
      expect(holder.api!.supported.value).toBe(false);
      await flushPromises();

      expect(mockFetch).toHaveBeenCalledWith("http://test/connections/abc/capabilities");
      expect(holder.api!.supported.value).toBe(true);
      wrapper.unmount();
    });

    it("stays unsupported when the flag is absent", async () => {
      mockFetch.mockResolvedValueOnce({ id: "abc", capabilities: { has_dump: true } });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);
      await flushPromises();

      expect(holder.api!.supported.value).toBe(false);
      wrapper.unmount();
    });

    it("stays unsupported when the probe itself fails", async () => {
      // The panel loses one optional refinement; everything else still
      // works, so an unreachable probe is not an error to show.
      mockFetch.mockRejectedValueOnce(new Error("network"));
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);
      await flushPromises();

      expect(holder.api!.supported.value).toBe(false);
      wrapper.unmount();
    });
  });

  describe("describeAll", () => {
    async function mounted() {
      mockFetch.mockResolvedValueOnce({ id: "abc", capabilities: { has_describe_table: true } });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);
      await flushPromises();
      mockFetch.mockReset();
      return { holder, wrapper };
    }

    it("describes every table, qualified ones by schema and bare ones without", async () => {
      const { holder, wrapper } = await mounted();
      answerDescribes();

      const result = await holder.api!.describeAll([
        { schema: "public", name: "users" },
        { schema: null, name: "kv" },
      ]);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://test/connections/abc/table-schema?table=users&schema=public",
      );
      expect(mockFetch).toHaveBeenCalledWith("http://test/connections/abc/table-schema?table=kv");
      expect(result.failed).toBe(0);
      expect(result.schemas.map((s) => s.table.name)).toEqual(["users", "kv"]);
      wrapper.unmount();
    });

    it("keeps the input order, not the order the answers came back in", async () => {
      // The prompt reads top to bottom; a schema block whose order shuffles
      // per run makes two identical prompts look like different questions.
      const { holder, wrapper } = await mounted();
      const resolvers: Array<() => void> = [];
      mockFetch.mockImplementation((url: string) => {
        const name = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("table") ?? "?";
        return new Promise((resolve) => {
          resolvers.push(() => {
            resolve(described(name));
          });
        });
      });

      const pending = holder.api!.describeAll([
        { schema: "public", name: "a" },
        { schema: "public", name: "b" },
      ]);
      await flushPromises();
      // Answer the second one first.
      resolvers[1]?.();
      resolvers[0]?.();
      const result = await pending;

      expect(result.schemas.map((s) => s.table.name)).toEqual(["a", "b"]);
      wrapper.unmount();
    });

    it("runs at most 8 describes at a time", async () => {
      // A 200-table Postgres schema must not open 200 sockets at once —
      // desktop caps the same fan-out with a semaphore of 8.
      const { holder, wrapper } = await mounted();
      let inFlight = 0;
      let peak = 0;
      const release: Array<() => void> = [];
      mockFetch.mockImplementation((url: string) => {
        const name = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("table") ?? "?";
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise((resolve) => {
          release.push(() => {
            inFlight -= 1;
            resolve(described(name));
          });
        });
      });

      const tables: TableInfo[] = Array.from({ length: 20 }, (_, i) => ({
        schema: null,
        name: `t${i}`,
      }));
      const pending = holder.api!.describeAll(tables);
      // Drain in waves so the pool has to refill rather than fire once.
      for (let drained = 0; drained < 20; drained += 1) {
        await flushPromises();
        release[drained]?.();
      }
      await flushPromises();
      const result = await pending;

      expect(peak).toBe(8);
      expect(result.schemas).toHaveLength(20);
      wrapper.unmount();
    });

    it("counts the tables it could not describe and returns the rest", async () => {
      const { holder, wrapper } = await mounted();
      mockFetch.mockImplementation((url: string) => {
        const name = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("table") ?? "?";
        return name === "broken"
          ? Promise.reject(new Error("no such table"))
          : Promise.resolve(described(name));
      });

      const result = await holder.api!.describeAll([
        { schema: "public", name: "users" },
        { schema: "public", name: "broken" },
        { schema: "public", name: "orders" },
      ]);

      expect(result.failed).toBe(1);
      expect(result.schemas.map((s) => s.table.name)).toEqual(["users", "orders"]);
      wrapper.unmount();
    });

    it("reports every table failing as an empty result rather than an error", async () => {
      const { holder, wrapper } = await mounted();
      mockFetch.mockRejectedValue(new Error("down"));

      const result = await holder.api!.describeAll([{ schema: null, name: "kv" }]);

      expect(result).toEqual({ schemas: [], failed: 1 });
      wrapper.unmount();
    });

    it("describes again on the next call — no cache (ADR-0028 Decision 7)", async () => {
      // A schema change on the server has to show up on the very next
      // Suggest; a cached description would prompt the model with a table
      // that no longer looks like that.
      const { holder, wrapper } = await mounted();
      answerDescribes();

      await holder.api!.describeAll([{ schema: null, name: "kv" }]);
      await holder.api!.describeAll([{ schema: null, name: "kv" }]);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      wrapper.unmount();
    });

    it("asks nothing when there are no tables", async () => {
      const { holder, wrapper } = await mounted();

      const result = await holder.api!.describeAll([]);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toEqual({ schemas: [], failed: 0 });
      wrapper.unmount();
    });
  });
});
