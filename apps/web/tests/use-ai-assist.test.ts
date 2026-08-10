import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { apiFetch } from "../app/composables/internal/http";
import { openSseStream, type SseStreamInit } from "../app/composables/internal/sse";
import { useAiAssist } from "../app/composables/useAiAssist";

// Phase 6 Slice 3 (ticket 0022) — UI-layer composable wrapping the
// Slice 2 POST /ai/explain + POST /ai/suggest routes. AI routes are
// connection-agnostic (the SQL lives in the body), so unlike
// useSchemaBrowser / useQueryHistory this composable takes no
// connectionId. State is shared across both methods because the panel
// shows one shared spinner and disables both buttons while one call is
// in flight.

vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("../app/composables/internal/sse", () => ({
  openSseStream: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);
const mockStream = vi.mocked(openSseStream);

// Turns a list of already-decoded StreamEvents into what openSseStream
// hands back. The transport's own framing is covered by tests/sse.test.ts;
// here the events are the input.
function streamOf(events: unknown[]): AsyncGenerator<unknown> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

// Yields its events and then parks until the caller aborts, which is how
// a real stream behaves while the model is still producing tokens. The
// abort surfaces the way fetch surfaces one, so the composable is tested
// against the shape it will actually see.
function hangingStream(
  events: unknown[],
): (url: string, init: SseStreamInit) => AsyncGenerator<unknown> {
  return (_url, init) =>
    (async function* () {
      for (const event of events) yield event;
      await new Promise<void>((resolve) => {
        init.signal?.addEventListener("abort", () => {
          resolve();
        });
      });
      throw new DOMException("The operation was aborted.", "AbortError");
    })();
}

type AiApi = ReturnType<typeof useAiAssist>;

function makeHarness(apiBase = "http://test") {
  const holder: { api: AiApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useAiAssist({ apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

// A getter, so changing the selector does not mean rebuilding the
// composable and losing the response already on screen.
function makeProviderHarness(provider: () => string | undefined) {
  const holder: { api: AiApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useAiAssist({ apiBase: "http://test", provider });
      return () => h("div");
    },
  });
  return { Component, holder };
}

describe("useAiAssist", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockStream.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts idle with no response and no error", () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.lastResponse.value).toBeNull();
    expect(holder.api!.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("explain() POSTs {sql} to /ai/explain and stores response with mode=explain", async () => {
    mockFetch.mockResolvedValueOnce({ text: "This selects everything.", model: "claude-x" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.explain("SELECT 1");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/ai/explain", {
      method: "POST",
      body: { sql: "SELECT 1" },
    });
    expect(holder.api!.lastResponse.value).toEqual({
      text: "This selects everything.",
      model: "claude-x",
      mode: "explain",
    });
    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("explain() includes dialect when provided", async () => {
    mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.explain("SELECT 1", "postgres");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/ai/explain", {
      method: "POST",
      body: { sql: "SELECT 1", dialect: "postgres" },
    });
    wrapper.unmount();
  });

  it("suggestSql() POSTs {prompt} to /ai/suggest and stores response with mode=suggest", async () => {
    mockFetch.mockResolvedValueOnce({ text: "SELECT COUNT(*) FROM users;", model: "claude-y" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.suggestSql("count all users");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/ai/suggest", {
      method: "POST",
      body: { prompt: "count all users" },
    });
    expect(holder.api!.lastResponse.value).toEqual({
      text: "SELECT COUNT(*) FROM users;",
      model: "claude-y",
      mode: "suggest",
    });
    wrapper.unmount();
  });

  it("suggestSql() includes dialect when provided", async () => {
    mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.suggestSql("count users", "sqlite");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/ai/suggest", {
      method: "POST",
      body: { prompt: "count users", dialect: "sqlite" },
    });
    wrapper.unmount();
  });

  it("transitions through loading → idle on success", async () => {
    let resolve: ((value: unknown) => void) | null = null;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    const pending = holder.api!.explain("SELECT 1");
    expect(holder.api!.state.value).toBe("loading");

    resolve!({ text: "x", model: "m" });
    await pending;
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("surfaces an ai_disabled envelope as a CategorisedError", async () => {
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "ai_disabled", message: "AI provider is not configured" } },
    });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.explain("SELECT 1");
    await flushPromises();

    expect(holder.api!.state.value).toBe("error");
    expect(holder.api!.lastError.value?.category).toBe("ai_disabled");
    expect(holder.api!.lastError.value?.i18nKey).toBe("error.prefix.ai-disabled");
    expect(holder.api!.lastResponse.value).toBeNull();
    wrapper.unmount();
  });

  it("surfaces an ai_provider envelope as a CategorisedError", async () => {
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "ai_provider", message: "Upstream model unavailable" } },
    });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.suggestSql("anything");
    await flushPromises();

    expect(holder.api!.state.value).toBe("error");
    expect(holder.api!.lastError.value?.category).toBe("ai_provider");
    expect(holder.api!.lastError.value?.i18nKey).toBe("error.prefix.ai-provider");
    wrapper.unmount();
  });

  it("clears lastError on a successful call after a failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));
    mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.explain("SELECT 1");
    await flushPromises();
    expect(holder.api!.lastError.value).not.toBeNull();

    await holder.api!.explain("SELECT 2");
    await flushPromises();
    expect(holder.api!.lastError.value).toBeNull();
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("replaces the previous response on a subsequent successful call", async () => {
    mockFetch.mockResolvedValueOnce({ text: "first", model: "m1" });
    mockFetch.mockResolvedValueOnce({ text: "second", model: "m2" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.explain("SELECT 1");
    await flushPromises();
    expect(holder.api!.lastResponse.value?.text).toBe("first");

    await holder.api!.suggestSql("hello");
    await flushPromises();
    expect(holder.api!.lastResponse.value).toEqual({
      text: "second",
      model: "m2",
      mode: "suggest",
    });
    wrapper.unmount();
  });
  // ADR-0028 Decision 8 (terse half) — the table list the caller
  // introspected. Absent and empty are different claims and the wire
  // carries the difference: no key at all means "we did not look".
  describe("schema", () => {
    it("suggestSql() includes the table list when given one", async () => {
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.suggestSql("recent orders", "postgres", [
        { schema: "public", name: "users" },
        { schema: null, name: "orders" },
      ]);
      await flushPromises();

      expect(mockFetch).toHaveBeenCalledWith("http://test/ai/suggest", {
        method: "POST",
        body: {
          prompt: "recent orders",
          dialect: "postgres",
          schema: [
            { schema: "public", name: "users" },
            { schema: null, name: "orders" },
          ],
        },
      });
      wrapper.unmount();
    });

    it("suggestSql() sends an empty list as an empty list, not as nothing", async () => {
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.suggestSql("anything", undefined, []);
      await flushPromises();

      expect(mockFetch).toHaveBeenCalledWith("http://test/ai/suggest", {
        method: "POST",
        body: { prompt: "anything", schema: [] },
      });
      wrapper.unmount();
    });

    it("suggestSql() omits the key entirely when no list is passed", async () => {
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.suggestSql("anything");
      await flushPromises();

      const body = mockFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
      expect(body).not.toHaveProperty("schema");
      wrapper.unmount();
    });

    it("explain() never carries a table list — it already has the SQL", async () => {
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.explain("SELECT 1", "postgres");
      await flushPromises();

      const body = mockFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
      expect(body).not.toHaveProperty("schema");
      wrapper.unmount();
    });
  });

  // ADR-0028 Decision 9 (full half) — the described tables, when the
  // panel prefetched them. A fourth argument rather than a replacement
  // for the third: both halves travel together, and the terse list is
  // what the API falls back to when the fan-out came back empty.
  describe("full_schema", () => {
    const USERS = {
      table: { schema: "public", name: "users" },
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

    it("suggestSql() sends the described tables alongside the terse list", async () => {
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.suggestSql(
        "recent orders",
        "postgres",
        [{ schema: "public", name: "users" }],
        [USERS],
      );
      await flushPromises();

      expect(mockFetch).toHaveBeenCalledWith("http://test/ai/suggest", {
        method: "POST",
        body: {
          prompt: "recent orders",
          dialect: "postgres",
          schema: [{ schema: "public", name: "users" }],
          full_schema: [USERS],
        },
      });
      wrapper.unmount();
    });

    it("suggestSql() omits the key entirely when the panel did not prefetch", async () => {
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.suggestSql("anything", undefined, []);
      await flushPromises();

      const body = mockFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
      expect(body).not.toHaveProperty("full_schema");
      wrapper.unmount();
    });

    it("suggestSql() sends an empty prefetch as an empty list — the API falls back", async () => {
      // Every table failed to describe. The key still goes on the wire so
      // the fallback is the server's decision to make, not a shape the
      // browser silently rewrote into "we never asked".
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.suggestSql("anything", undefined, [{ schema: null, name: "t" }], []);
      await flushPromises();

      expect(mockFetch).toHaveBeenCalledWith("http://test/ai/suggest", {
        method: "POST",
        body: { prompt: "anything", schema: [{ schema: null, name: "t" }], full_schema: [] },
      });
      wrapper.unmount();
    });

    it("streamSuggestSql() carries it too — one body shape for both routes", async () => {
      mockStream.mockReturnValueOnce(
        streamOf([
          { type: "message_start", tokensIn: 1, model: "m" },
          { type: "message_stop", stopReason: "end_turn" },
        ]),
      );
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.streamSuggestSql("recent orders", undefined, undefined, [USERS]);

      expect(mockStream).toHaveBeenCalledWith(
        "http://test/ai/suggest/stream",
        expect.objectContaining({ body: { prompt: "recent orders", full_schema: [USERS] } }),
      );
      wrapper.unmount();
    });
  });

  // Ticket 0032 slice B — which configured provider answers. It is an
  // option on the composable rather than an argument to explain() /
  // suggestSql() because the selection is one piece of panel state
  // applied to both calls, not something a caller decides per request.
  describe("provider", () => {
    it("names the selected provider on an explain", async () => {
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      const { Component, holder } = makeProviderHarness(() => "deep");
      const wrapper = mount(Component);

      await holder.api!.explain("SELECT 1");
      await flushPromises();

      expect(mockFetch).toHaveBeenCalledWith("http://test/ai/explain", {
        method: "POST",
        body: { sql: "SELECT 1", provider: "deep" },
      });
      wrapper.unmount();
    });

    it("names the selected provider on a suggest", async () => {
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      const { Component, holder } = makeProviderHarness(() => "fast");
      const wrapper = mount(Component);

      await holder.api!.suggestSql("count users");
      await flushPromises();

      expect(mockFetch).toHaveBeenCalledWith("http://test/ai/suggest", {
        method: "POST",
        body: { prompt: "count users", provider: "fast" },
      });
      wrapper.unmount();
    });

    it("re-reads the getter per call, so changing the selector changes who answers", async () => {
      mockFetch.mockResolvedValue({ text: "ok", model: "m" });
      let current: string | undefined = "fast";
      const { Component, holder } = makeProviderHarness(() => current);
      const wrapper = mount(Component);

      await holder.api!.explain("SELECT 1");
      current = "deep";
      await holder.api!.explain("SELECT 2");
      await flushPromises();

      const bodies = mockFetch.mock.calls.map((c) => c[1]?.body as Record<string, unknown>);
      expect(bodies.map((b) => b.provider)).toEqual(["fast", "deep"]);
      wrapper.unmount();
    });

    // A deployment with one provider sends no name at all, which is the
    // request Stage 1 made. Sending the default explicitly would work,
    // but it would also make every old deployment's traffic change shape
    // for no reason the server can act on.
    it("omits the key when nothing is selected", async () => {
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      const { Component, holder } = makeProviderHarness(() => undefined);
      const wrapper = mount(Component);

      await holder.api!.explain("SELECT 1");
      await flushPromises();

      const body = mockFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
      expect(body).not.toHaveProperty("provider");
      wrapper.unmount();
    });

    it("omits the key when no getter was given at all", async () => {
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.suggestSql("anything");
      await flushPromises();

      const body = mockFetch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
      expect(body).not.toHaveProperty("provider");
      wrapper.unmount();
    });
  });

  // Ticket 0032 slice C2 — the streaming twins. Same bodies, same
  // provider selection, same error surface; what differs is that the
  // answer arrives in pieces and can be stopped part-way (ADR-0026).
  describe("streaming", () => {
    const START = { type: "message_start", tokensIn: 12, model: "claude-x" };
    const STOP = { type: "message_stop", stopReason: "end_turn" };

    it("streamExplain() POSTs {sql} to /ai/explain/stream", async () => {
      mockStream.mockReturnValueOnce(streamOf([START, { type: "text_delta", text: "hi" }, STOP]));
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.streamExplain("SELECT 1");

      expect(mockStream).toHaveBeenCalledWith(
        "http://test/ai/explain/stream",
        expect.objectContaining({ body: { sql: "SELECT 1" } }),
      );
      wrapper.unmount();
    });

    it("streamSuggestSql() POSTs {prompt} to /ai/suggest/stream", async () => {
      mockStream.mockReturnValueOnce(streamOf([START, STOP]));
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.streamSuggestSql("count users");

      expect(mockStream).toHaveBeenCalledWith(
        "http://test/ai/suggest/stream",
        expect.objectContaining({ body: { prompt: "count users" } }),
      );
      wrapper.unmount();
    });

    it("carries dialect, schema and the selected provider, same as the atomic calls", async () => {
      mockStream.mockReturnValueOnce(streamOf([START, STOP]));
      const { Component, holder } = makeProviderHarness(() => "deep");
      const wrapper = mount(Component);

      await holder.api!.streamSuggestSql("count users", "postgres", []);

      expect(mockStream).toHaveBeenCalledWith(
        "http://test/ai/suggest/stream",
        expect.objectContaining({
          body: { prompt: "count users", dialect: "postgres", schema: [], provider: "deep" },
        }),
      );
      wrapper.unmount();
    });

    it("accumulates text_delta into one response and reports the model from message_start", async () => {
      mockStream.mockReturnValueOnce(
        streamOf([
          START,
          { type: "text_delta", text: "This " },
          { type: "text_delta", text: "selects " },
          { type: "text_delta", text: "everything." },
          STOP,
        ]),
      );
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.streamExplain("SELECT 1");

      expect(holder.api!.lastResponse.value).toEqual({
        text: "This selects everything.",
        model: "claude-x",
        mode: "explain",
      });
      expect(holder.api!.state.value).toBe("idle");
      expect(holder.api!.lastError.value).toBeNull();
      wrapper.unmount();
    });

    it("reports state 'streaming' while the answer is still arriving", async () => {
      mockStream.mockImplementationOnce(
        hangingStream([START, { type: "text_delta", text: "Hel" }]),
      );
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      const pending = holder.api!.streamExplain("SELECT 1");
      await flushPromises();

      expect(holder.api!.state.value).toBe("streaming");
      expect(holder.api!.lastResponse.value?.text).toBe("Hel");

      holder.api!.cancel();
      await pending;
      wrapper.unmount();
    });

    // ADR-0026 Decision 7. Anthropic reports `output_tokens` cumulatively,
    // so a meter that added each report would show 35 for a 25-token
    // answer — and the number would look plausible.
    it("replaces the token meter on each usage report rather than summing", async () => {
      mockStream.mockReturnValueOnce(
        streamOf([
          START,
          { type: "usage", tokensIn: 12, tokensOut: 10 },
          { type: "usage", tokensIn: 12, tokensOut: 25 },
          STOP,
        ]),
      );
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.streamExplain("SELECT 1");

      expect(holder.api!.tokensOut.value).toBe(25);
      expect(holder.api!.tokensIn.value).toBe(12);
      wrapper.unmount();
    });

    it("keeps the previous count when a usage event reports null", async () => {
      mockStream.mockReturnValueOnce(
        streamOf([
          START,
          { type: "usage", tokensIn: 12, tokensOut: 25 },
          { type: "usage", tokensIn: null, tokensOut: null },
          STOP,
        ]),
      );
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.streamExplain("SELECT 1");

      expect(holder.api!.tokensIn.value).toBe(12);
      expect(holder.api!.tokensOut.value).toBe(25);
      wrapper.unmount();
    });

    it("clears the meter and the previous answer when a new stream starts", async () => {
      mockStream.mockReturnValueOnce(
        streamOf([START, { type: "usage", tokensIn: 12, tokensOut: 25 }, STOP]),
      );
      mockStream.mockReturnValueOnce(
        streamOf([{ type: "message_start", tokensIn: null, model: null }, STOP]),
      );
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.streamExplain("SELECT 1");
      await holder.api!.streamExplain("SELECT 2");

      expect(holder.api!.tokensIn.value).toBeNull();
      expect(holder.api!.tokensOut.value).toBeNull();
      expect(holder.api!.lastResponse.value?.text).toBe("");
      wrapper.unmount();
    });

    // The stream has already sent its 200, so a failure past that point
    // arrives in band (ai-sse.ts). It must land in the same banner an
    // atomic failure lands in, or a streamed error would render nothing.
    it("surfaces an in-band error event as a provider error", async () => {
      mockStream.mockReturnValueOnce(
        streamOf([
          START,
          { type: "text_delta", text: "partial" },
          { type: "error", category: "network", message: "Upstream connection reset" },
        ]),
      );
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.streamExplain("SELECT 1");

      expect(holder.api!.state.value).toBe("error");
      expect(holder.api!.lastError.value).toEqual({
        category: "ai_provider",
        message: "Upstream connection reset",
        i18nKey: "error.prefix.ai-provider",
      });
      wrapper.unmount();
    });

    it("surfaces a pre-stream refusal through the same envelope path as the atomic calls", async () => {
      mockStream.mockImplementationOnce(() => {
        throw Object.assign(new Error("404"), {
          data: { error: { category: "ai_disabled", message: "AI provider is not configured" } },
        });
      });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.streamExplain("SELECT 1");

      expect(holder.api!.state.value).toBe("error");
      expect(holder.api!.lastError.value?.category).toBe("ai_disabled");
      wrapper.unmount();
    });

    it("surfaces an unknown provider refusal with its own i18n key", async () => {
      mockStream.mockImplementationOnce(() => {
        throw Object.assign(new Error("422"), {
          data: {
            error: {
              category: "ai_unknown_provider",
              message: 'AI provider "gpt-4o" is not configured',
            },
          },
        });
      });
      const { Component, holder } = makeHarness();
      const wrapper = mount(Component);

      await holder.api!.streamSuggestSql("count users");

      expect(holder.api!.lastError.value?.i18nKey).toBe("error.prefix.ai-unknown-provider");
      wrapper.unmount();
    });

    // ADR-0026 Decision 12: cancelling is not failing. No banner, the
    // partial answer stays on screen, and the panel says "Cancelled."
    describe("cancel", () => {
      it("keeps the partial answer, sets wasCancelled and leaves no error", async () => {
        mockStream.mockImplementationOnce(
          hangingStream([START, { type: "text_delta", text: "Half an ans" }]),
        );
        const { Component, holder } = makeHarness();
        const wrapper = mount(Component);

        const pending = holder.api!.streamExplain("SELECT 1");
        await flushPromises();
        holder.api!.cancel();
        await pending;

        expect(holder.api!.wasCancelled.value).toBe(true);
        expect(holder.api!.state.value).toBe("idle");
        expect(holder.api!.lastError.value).toBeNull();
        expect(holder.api!.lastResponse.value?.text).toBe("Half an ans");
        wrapper.unmount();
      });

      // The signal must reach the transport, not merely stop the reader:
      // an upstream left generating bills for tokens nobody receives.
      it("aborts the signal it handed the transport", async () => {
        let seen: AbortSignal | undefined;
        mockStream.mockImplementationOnce((_url: string, init: SseStreamInit) => {
          seen = init.signal;
          return hangingStream([START])(_url, init);
        });
        const { Component, holder } = makeHarness();
        const wrapper = mount(Component);

        const pending = holder.api!.streamExplain("SELECT 1");
        await flushPromises();
        expect(seen?.aborted).toBe(false);

        holder.api!.cancel();
        expect(seen?.aborted).toBe(true);
        await pending;
        wrapper.unmount();
      });

      it("is a no-op when nothing is in flight", () => {
        const { Component, holder } = makeHarness();
        const wrapper = mount(Component);

        expect(() => holder.api!.cancel()).not.toThrow();
        expect(holder.api!.state.value).toBe("idle");
        expect(holder.api!.wasCancelled.value).toBe(false);
        wrapper.unmount();
      });

      it("clears the cancelled flag when the next stream starts", async () => {
        mockStream.mockImplementationOnce(hangingStream([START]));
        mockStream.mockReturnValueOnce(streamOf([START, STOP]));
        const { Component, holder } = makeHarness();
        const wrapper = mount(Component);

        const first = holder.api!.streamExplain("SELECT 1");
        await flushPromises();
        holder.api!.cancel();
        await first;

        await holder.api!.streamExplain("SELECT 2");

        expect(holder.api!.wasCancelled.value).toBe(false);
        wrapper.unmount();
      });
    });
  });
});
