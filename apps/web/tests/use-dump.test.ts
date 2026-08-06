import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { rawFetch } from "../app/composables/internal/download";
import { useDump } from "../app/composables/useDump";

// Same indirection swap as useQueryExecution.test.ts — a download needs the
// raw Response (status, headers, body), so it goes through `rawFetch` rather
// than the `$fetch` wrapper the JSON endpoints use.
vi.mock("../app/composables/internal/download", () => ({
  rawFetch: vi.fn(),
  saveBlob: vi.fn(),
}));

const mockFetch = vi.mocked(rawFetch);

type DumpApi = ReturnType<typeof useDump>;

function makeHarness(connectionId = "c1", apiBase = "http://test") {
  const holder: { api: DumpApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useDump(connectionId, { apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

function sqlResponse(body = "-- dump\n", filename = "dbboard-dump-c1.sql"): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/sql; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

function errorResponse(status: number, category: string, message: string): Response {
  return new Response(JSON.stringify({ error: { category, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useDump", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not fetch on mount — a dump is user-initiated only", async () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("GETs the dump route and saves the file the server named", async () => {
    const { saveBlob } = await import("../app/composables/internal/download");
    mockFetch.mockResolvedValueOnce(sqlResponse("-- dbboard logical dump\n", "server-chosen.sql"));
    const { Component, holder } = makeHarness("prod-pg");
    const wrapper = mount(Component);

    await holder.api!.start();

    expect(mockFetch).toHaveBeenCalledWith("http://test/connections/prod-pg/dump");
    const [blob, filename] = vi.mocked(saveBlob).mock.calls[0]!;
    expect(await blob.text()).toBe("-- dbboard logical dump\n");
    // The server named the file; the client does not second-guess it.
    expect(filename).toBe("server-chosen.sql");
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("falls back to a local filename when the header is missing", async () => {
    const { saveBlob } = await import("../app/composables/internal/download");
    mockFetch.mockResolvedValueOnce(new Response("-- dump\n", { status: 200 }));
    const { Component, holder } = makeHarness("prod-pg");
    const wrapper = mount(Component);

    await holder.api!.start();

    expect(vi.mocked(saveBlob).mock.calls[0]![1]).toBe("dbboard-dump-prod-pg.sql");
    wrapper.unmount();
  });

  it("percent-encodes the connection id into the path", async () => {
    mockFetch.mockResolvedValueOnce(sqlResponse());
    const { Component, holder } = makeHarness("a/b?c");
    const wrapper = mount(Component);

    await holder.api!.start();

    expect(mockFetch).toHaveBeenCalledWith("http://test/connections/a%2Fb%3Fc/dump");
    wrapper.unmount();
  });

  // The size gate is warn-and-allow: the first refusal is a question, not a
  // failure, so it must not land in the error banner.
  it("turns the size refusal into a confirmation prompt", async () => {
    const { saveBlob } = await import("../app/composables/internal/download");
    mockFetch.mockResolvedValueOnce(
      errorResponse(400, "query", "this database holds 600000 rows, over the 500000-row threshold"),
    );
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.start();

    expect(holder.api!.state.value).toBe("confirm");
    expect(holder.api!.pendingConfirm.value).toContain("600000");
    expect(holder.api!.lastError.value).toBeNull();
    expect(saveBlob).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("re-sends with confirm=true and clears the prompt on success", async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(400, "query", "over the threshold"))
      .mockResolvedValueOnce(sqlResponse());
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.start();
    await holder.api!.start(true);

    expect(mockFetch).toHaveBeenLastCalledWith("http://test/connections/c1/dump?confirm=true");
    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.pendingConfirm.value).toBeNull();
    wrapper.unmount();
  });

  // Confirming does not make a second refusal a question again — that would
  // loop the prompt forever.
  it("reports a refusal that survives the confirmation as an error", async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(400, "query", "over the threshold"))
      .mockResolvedValueOnce(errorResponse(400, "query", "still refused"));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.start();
    await holder.api!.start(true);

    expect(holder.api!.state.value).toBe("failed");
    expect(holder.api!.lastError.value?.message).toBe("still refused");
    expect(holder.api!.pendingConfirm.value).toBeNull();
    wrapper.unmount();
  });

  it("surfaces a non-size refusal through the shared error envelope", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(404, "capability", "adapter cannot reconstruct table DDL: null"),
    );
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.start();

    expect(holder.api!.state.value).toBe("failed");
    expect(holder.api!.lastError.value).toMatchObject({
      category: "capability",
      i18nKey: "error.prefix.capability",
    });
    wrapper.unmount();
  });

  it("survives an error response that is not the contract envelope", async () => {
    mockFetch.mockResolvedValueOnce(new Response("<html>502</html>", { status: 502 }));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.start();

    expect(holder.api!.state.value).toBe("failed");
    expect(holder.api!.lastError.value?.category).toBe("connection");
    wrapper.unmount();
  });

  it("reports a transport failure rather than throwing at the caller", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await expect(holder.api!.start()).resolves.toBeUndefined();

    expect(holder.api!.state.value).toBe("failed");
    expect(holder.api!.lastError.value?.message).toBe("network down");
    wrapper.unmount();
  });

  it("is running while the request is in flight", async () => {
    let release: ((res: Response) => void) | undefined;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    const pending = holder.api!.start();
    await flushPromises();
    expect(holder.api!.state.value).toBe("running");

    release!(sqlResponse());
    await pending;
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("dismisses the prompt without dumping", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(400, "query", "over the threshold"));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.start();
    holder.api!.dismiss();

    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.pendingConfirm.value).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
