import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../app/composables/internal/http";
import { openSseStream, type SseStreamInit } from "../app/composables/internal/sse";
import AiPanel from "../app/components/AiPanel.vue";

vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("../app/composables/internal/sse", () => ({
  openSseStream: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);
const mockStream = vi.mocked(openSseStream);

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
  }),
}));

const baseProps = { currentSql: "SELECT 1", apiBase: "http://test" };

// Ticket 0032 slice B — the panel asks which providers exist as soon as
// it mounts, so every mount consumes one queued response before the one
// the test is about. `mountPanel` answers that question and settles it,
// leaving the mock queue empty for the test's own turn.
//
// The default answer is a single provider, which is the Stage 1
// deployment: one configured provider means no choice to make, so the
// panel renders no selector and its requests are byte-identical to the
// ones made before this slice existed. That is what lets the cases
// below keep asserting exact bodies.
const ONE_PROVIDER = {
  providers: [
    {
      id: "anthropic",
      name: "anthropic",
      kind: "anthropic",
      model: "claude-x",
      default: true,
      streaming: true,
    },
  ],
};

// The other Stage 1 shape: a provider that answers the streaming routes
// but has no SSE transport behind them, so it would yield the whole
// answer in one chunk. ADR-0026 Decision 8 keeps the toggle off screen
// for it rather than offering a mode that streams nothing.
const ONE_NON_STREAMING_PROVIDER = {
  providers: [
    {
      id: "anthropic",
      name: "anthropic",
      kind: "anthropic",
      model: "claude-x",
      default: true,
      streaming: false,
    },
  ],
};

const TWO_PROVIDERS = {
  providers: [
    {
      id: "fast",
      name: "Fast",
      kind: "anthropic",
      model: "claude-sonnet-4-6",
      default: false,
      streaming: true,
    },
    {
      id: "deep",
      name: "Deep",
      kind: "anthropic",
      model: "claude-opus-4-8",
      default: true,
      streaming: false,
    },
  ],
};

async function mountPanel(
  props: Record<string, unknown> = baseProps,
  providers: unknown = ONE_PROVIDER,
) {
  mockFetch.mockResolvedValueOnce(providers);
  const wrapper = mount(AiPanel, { props });
  await flushPromises();
  return wrapper;
}

function lastBody(): Record<string, unknown> {
  return mockFetch.mock.lastCall?.[1]?.body as Record<string, unknown>;
}

// Turns a list of already-decoded StreamEvents into what openSseStream
// hands back. The transport's own framing is covered by tests/sse.test.ts.
function streamOf(events: unknown[]): AsyncGenerator<unknown> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

// Yields its events and then parks until the caller aborts, which is how
// a real stream behaves while the model is still producing tokens — the
// only state in which the panel offers a Cancel button.
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

describe("AiPanel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockStream.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the panel with the ai-panel testid and both sections", async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find("[data-testid='ai-panel']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='ai-explain-section']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='ai-suggest-section']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("clicking explain POSTs the currentSql prop and renders the explain response", async () => {
    const wrapper = await mountPanel();
    mockFetch.mockResolvedValueOnce({ text: "This selects 1.", model: "claude-x" });

    await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
    await flushPromises();

    expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/explain", {
      method: "POST",
      body: { sql: "SELECT 1" },
    });
    const explainOutput = wrapper.find("[data-testid='ai-explain-output']");
    expect(explainOutput.exists()).toBe(true);
    expect(explainOutput.text()).toContain("This selects 1.");
    wrapper.unmount();
  });

  it("clicking suggest POSTs the prompt textarea value and renders the suggest response", async () => {
    const wrapper = await mountPanel();
    mockFetch.mockResolvedValueOnce({ text: "SELECT COUNT(*) FROM users;", model: "claude-y" });

    await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("count all users");
    await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
    await flushPromises();

    expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/suggest", {
      method: "POST",
      body: { prompt: "count all users" },
    });
    const suggestOutput = wrapper.find("[data-testid='ai-suggest-output']");
    expect(suggestOutput.exists()).toBe(true);
    expect(suggestOutput.text()).toContain("SELECT COUNT(*) FROM users;");
    wrapper.unmount();
  });

  it("passes the dialect input through to both methods", async () => {
    const wrapper = await mountPanel();
    mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

    await wrapper.find("[data-testid='ai-dialect-input']").setValue("postgres");
    await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
    await flushPromises();

    expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/explain", {
      method: "POST",
      body: { sql: "SELECT 1", dialect: "postgres" },
    });

    mockFetch.mockResolvedValueOnce({ text: "ok2", model: "m" });
    await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("hello");
    await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
    await flushPromises();

    expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/suggest", {
      method: "POST",
      body: { prompt: "hello", dialect: "postgres" },
    });
    wrapper.unmount();
  });

  it("suggest output exposes an insert button that emits the response text", async () => {
    const wrapper = await mountPanel();
    mockFetch.mockResolvedValueOnce({ text: "SELECT 42;", model: "m" });

    await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("whatever");
    await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
    await flushPromises();

    await wrapper.find("[data-testid='ai-suggest-insert']").trigger("click");
    const emitted = wrapper.emitted("insert");
    expect(emitted).toBeDefined();
    expect(emitted![0]).toEqual(["SELECT 42;"]);
    wrapper.unmount();
  });

  it("explain output has no insert button (only suggest output does)", async () => {
    const wrapper = await mountPanel();
    mockFetch.mockResolvedValueOnce({ text: "explanation", model: "m" });

    await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='ai-suggest-insert']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders the disabled-mode panel when the wire returns ai_disabled", async () => {
    const wrapper = await mountPanel();
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "ai_disabled", message: "AI provider is not configured" } },
    });

    await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='ai-disabled-notice']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='ai-error']").exists()).toBe(false);
    // Both action buttons disabled once we know the feature is off.
    expect(
      wrapper.find<HTMLButtonElement>("[data-testid='ai-explain-button']").element.disabled,
    ).toBe(true);
    expect(
      wrapper.find<HTMLButtonElement>("[data-testid='ai-suggest-button']").element.disabled,
    ).toBe(true);
    wrapper.unmount();
  });

  it("renders a generic error banner for non-ai_disabled errors", async () => {
    const wrapper = await mountPanel();
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "ai_provider", message: "Upstream model unavailable" } },
    });

    await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("anything");
    await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
    await flushPromises();

    const banner = wrapper.find("[data-testid='ai-error']");
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("error.prefix.ai-provider");
    expect(banner.text()).toContain("Upstream model unavailable");
    expect(wrapper.find("[data-testid='ai-disabled-notice']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("disables both buttons while a request is in flight", async () => {
    const wrapper = await mountPanel();
    let resolve: ((value: unknown) => void) | null = null;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );

    await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='ai-loading']").exists()).toBe(true);
    expect(
      wrapper.find<HTMLButtonElement>("[data-testid='ai-explain-button']").element.disabled,
    ).toBe(true);
    expect(
      wrapper.find<HTMLButtonElement>("[data-testid='ai-suggest-button']").element.disabled,
    ).toBe(true);

    resolve!({ text: "done", model: "m" });
    await flushPromises();
    expect(wrapper.find("[data-testid='ai-loading']").exists()).toBe(false);
    wrapper.unmount();
  });
  // ADR-0028 Decision 8 (terse half). The panel does not introspect: it
  // renders whatever list the page hands it, which keeps it as
  // connection-agnostic as the composable behind it.
  describe("table list", () => {
    const tables = [
      { schema: "public", name: "users" },
      { schema: null, name: "orders" },
    ];

    it("sends the tables prop with a suggest", async () => {
      const wrapper = await mountPanel({ ...baseProps, tables });
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("recent orders");
      await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
      await flushPromises();

      expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/suggest", {
        method: "POST",
        body: { prompt: "recent orders", schema: tables },
      });
      wrapper.unmount();
    });

    it("sends nothing about tables when the prop is absent", async () => {
      const wrapper = await mountPanel();
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("recent orders");
      await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
      await flushPromises();

      expect(lastBody()).not.toHaveProperty("schema");
      wrapper.unmount();
    });

    it("leaves explain alone — the SQL is the context there", async () => {
      const wrapper = await mountPanel({ ...baseProps, tables });
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/explain", {
        method: "POST",
        body: { sql: "SELECT 1" },
      });
      wrapper.unmount();
    });
  });

  // ADR-0028 Decision 9 (described half). The panel owns the checkbox and
  // the spinner; the page owns the connection, so the fan-out arrives as a
  // callback rather than the panel learning a connection id.
  describe("column details", () => {
    const tables = [
      { schema: "public", name: "users" },
      { schema: null, name: "orders" },
    ];

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

    function describeOk(schemas: unknown[] = [USERS], failed = 0) {
      return vi.fn().mockResolvedValue({ schemas, failed });
    }

    /** Mounted with the capability, the tables and the fan-out wired in. */
    async function mountDescribable(describeTables = describeOk()) {
      const wrapper = await mountPanel({
        ...baseProps,
        tables,
        canDescribe: true,
        describeTables,
      });
      return { wrapper, describeTables };
    }

    async function suggestWith(wrapper: ReturnType<typeof mount>) {
      await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("count users");
      await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
      await flushPromises();
    }

    // Desktop greys the box out rather than hiding it: a user who has
    // heard the feature exists should see why it is unavailable here,
    // not wonder whether this build has it (ADR-0028 Decision 4).
    it("renders the box disabled when the connection cannot describe tables", async () => {
      const wrapper = await mountPanel({ ...baseProps, tables });
      const box = wrapper.find<HTMLInputElement>("[data-testid='ai-details-toggle']");

      expect(box.exists()).toBe(true);
      expect(box.element.disabled).toBe(true);
      expect(box.element.checked).toBe(false);
      wrapper.unmount();
    });

    it("enables the box, still unchecked, once the connection advertises it", async () => {
      const { wrapper } = await mountDescribable();
      const box = wrapper.find<HTMLInputElement>("[data-testid='ai-details-toggle']");

      expect(box.element.disabled).toBe(false);
      expect(box.element.checked).toBe(false);
      wrapper.unmount();
    });

    // Decision 9's default. Unchecked has to be the request that existed
    // before this slice, down to the absent key.
    it("describes nothing and sends nothing while the box is unchecked", async () => {
      const { wrapper, describeTables } = await mountDescribable();
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await suggestWith(wrapper);

      expect(describeTables).not.toHaveBeenCalled();
      expect(lastBody()).not.toHaveProperty("full_schema");
      wrapper.unmount();
    });

    it("describes the tables and sends both halves when the box is ticked", async () => {
      const { wrapper, describeTables } = await mountDescribable();
      await wrapper.find("[data-testid='ai-details-toggle']").setValue(true);
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await suggestWith(wrapper);

      expect(describeTables).toHaveBeenCalledWith(tables);
      expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/suggest", {
        method: "POST",
        body: { prompt: "count users", schema: tables, full_schema: [USERS] },
      });
      wrapper.unmount();
    });

    // The same guard the stream toggle needs: a ticked box whose
    // capability goes away must not keep prefetching against a
    // connection that has said it cannot answer.
    it("stops describing when the capability goes away under a ticked box", async () => {
      const { wrapper, describeTables } = await mountDescribable();
      await wrapper.find("[data-testid='ai-details-toggle']").setValue(true);
      await wrapper.setProps({ canDescribe: false });
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await suggestWith(wrapper);

      expect(describeTables).not.toHaveBeenCalled();
      expect(lastBody()).not.toHaveProperty("full_schema");
      wrapper.unmount();
    });

    it("says it is fetching schemas while the fan-out runs", async () => {
      let release: (() => void) | null = null;
      const describeTables = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => {
              resolve({ schemas: [USERS], failed: 0 });
            };
          }),
      );
      const { wrapper } = await mountDescribable(describeTables);
      await wrapper.find("[data-testid='ai-details-toggle']").setValue(true);
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("count users");
      await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
      await flushPromises();

      expect(wrapper.find("[data-testid='ai-details-loading']").exists()).toBe(true);
      // Nothing has been asked of the model yet — only the provider list.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // The button cannot be pressed a second time into the same prefetch.
      expect(
        wrapper.find<HTMLButtonElement>("[data-testid='ai-suggest-button']").element.disabled,
      ).toBe(true);

      release!();
      await flushPromises();

      expect(wrapper.find("[data-testid='ai-details-loading']").exists()).toBe(false);
      wrapper.unmount();
    });

    // Decision 9: a partial fan-out is a warning, not a stop. The tables
    // that answered are worth prompting with.
    it("warns about the tables it could not describe and still asks", async () => {
      const { wrapper } = await mountDescribable(describeOk([USERS], 2));
      await wrapper.find("[data-testid='ai-details-toggle']").setValue(true);
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await suggestWith(wrapper);

      expect(wrapper.find("[data-testid='ai-details-warning']").text()).toBe(
        'ai.details.warning|{"count":2}',
      );
      expect(lastBody()).toMatchObject({ full_schema: [USERS] });
      wrapper.unmount();
    });

    it("shows no warning when every table answered", async () => {
      const { wrapper } = await mountDescribable();
      await wrapper.find("[data-testid='ai-details-toggle']").setValue(true);
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await suggestWith(wrapper);

      expect(wrapper.find("[data-testid='ai-details-warning']").exists()).toBe(false);
      wrapper.unmount();
    });

    it("clears a stale warning when the next suggest goes out", async () => {
      const describeTables = vi
        .fn()
        .mockResolvedValueOnce({ schemas: [USERS], failed: 2 })
        .mockResolvedValueOnce({ schemas: [USERS], failed: 0 });
      const { wrapper } = await mountDescribable(describeTables);
      await wrapper.find("[data-testid='ai-details-toggle']").setValue(true);
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      await suggestWith(wrapper);
      expect(wrapper.find("[data-testid='ai-details-warning']").exists()).toBe(true);

      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
      await suggestWith(wrapper);

      expect(wrapper.find("[data-testid='ai-details-warning']").exists()).toBe(false);
      wrapper.unmount();
    });

    it("carries the described tables into a streamed suggest too", async () => {
      const { wrapper, describeTables } = await mountDescribable();
      await wrapper.find("[data-testid='ai-details-toggle']").setValue(true);
      await wrapper.find("[data-testid='ai-stream-toggle']").setValue(true);
      mockStream.mockReturnValueOnce(
        streamOf([
          { type: "message_start", tokensIn: 1, model: "m" },
          { type: "message_stop", stopReason: "end_turn" },
        ]),
      );

      await suggestWith(wrapper);

      expect(describeTables).toHaveBeenCalledWith(tables);
      expect(mockStream.mock.lastCall?.[1].body).toEqual({
        prompt: "count users",
        schema: tables,
        full_schema: [USERS],
      });
      wrapper.unmount();
    });

    it("leaves explain alone — column detail is a suggest-only refinement", async () => {
      const { wrapper, describeTables } = await mountDescribable();
      await wrapper.find("[data-testid='ai-details-toggle']").setValue(true);
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(describeTables).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/explain", {
        method: "POST",
        body: { sql: "SELECT 1" },
      });
      wrapper.unmount();
    });
  });

  // Ticket 0032 slice B. Desktop puts the provider list in a settings
  // window; web has no settings window and no place to accept a key, so
  // the list is the operator's env block and the only thing left for the
  // user to do is pick from it.
  describe("provider selector", () => {
    it("asks the server which providers exist as soon as it mounts", async () => {
      const wrapper = await mountPanel();
      expect(mockFetch).toHaveBeenCalledWith("http://test/ai/providers");
      wrapper.unmount();
    });

    it("offers one option per configured provider, labelled by name", async () => {
      const wrapper = await mountPanel(baseProps, TWO_PROVIDERS);

      const select = wrapper.find("[data-testid='ai-provider-select']");
      expect(select.exists()).toBe(true);
      const options = select.findAll("option");
      expect(options.map((o) => o.attributes("value"))).toEqual(["fast", "deep"]);
      expect(options.map((o) => o.text())).toEqual(["Fast", "Deep"]);
      wrapper.unmount();
    });

    it("starts on the provider the server marked default", async () => {
      const wrapper = await mountPanel(baseProps, TWO_PROVIDERS);
      expect(
        wrapper.find<HTMLSelectElement>("[data-testid='ai-provider-select']").element.value,
      ).toBe("deep");
      wrapper.unmount();
    });

    it("sends the chosen provider with an explain", async () => {
      const wrapper = await mountPanel(baseProps, TWO_PROVIDERS);
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-provider-select']").setValue("fast");
      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/explain", {
        method: "POST",
        body: { sql: "SELECT 1", provider: "fast" },
      });
      wrapper.unmount();
    });

    it("sends the chosen provider with a suggest", async () => {
      const wrapper = await mountPanel(baseProps, TWO_PROVIDERS);
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-provider-select']").setValue("fast");
      await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("count users");
      await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
      await flushPromises();

      expect(lastBody().provider).toBe("fast");
      wrapper.unmount();
    });

    // One provider is not a choice. Rendering a select with a single
    // option would ask the user to confirm something they cannot change,
    // and naming it on the wire would make every Stage 1 deployment's
    // requests change shape for no reason the server can act on.
    it("renders no selector, and names nobody, when there is only one provider", async () => {
      const wrapper = await mountPanel();
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      expect(wrapper.find("[data-testid='ai-provider-select']").exists()).toBe(false);

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(lastBody()).not.toHaveProperty("provider");
      wrapper.unmount();
    });

    // The 404 from /ai/providers says the same thing the 404 from
    // /ai/explain says, and arrives without the user pressing anything.
    it("shows the disabled notice straight away when the deployment has no AI", async () => {
      mockFetch.mockRejectedValueOnce({
        data: { error: { category: "ai_disabled", message: "AI provider is not configured" } },
      });
      const wrapper = mount(AiPanel, { props: baseProps });
      await flushPromises();

      expect(wrapper.find("[data-testid='ai-disabled-notice']").exists()).toBe(true);
      expect(wrapper.find("[data-testid='ai-provider-select']").exists()).toBe(false);
      expect(
        wrapper.find<HTMLButtonElement>("[data-testid='ai-explain-button']").element.disabled,
      ).toBe(true);
      wrapper.unmount();
    });

    // A provider list that fails to load is not a reason to make the
    // panel unusable: the server still has a default, and a request that
    // names nobody still reaches it.
    it("stays usable when the provider list cannot be fetched", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network down"));
      const wrapper = mount(AiPanel, { props: baseProps });
      await flushPromises();
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      expect(wrapper.find("[data-testid='ai-disabled-notice']").exists()).toBe(false);
      expect(
        wrapper.find<HTMLButtonElement>("[data-testid='ai-explain-button']").element.disabled,
      ).toBe(false);

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/explain", {
        method: "POST",
        body: { sql: "SELECT 1" },
      });
      wrapper.unmount();
    });
  });

  // Ticket 0032 slice C, desktop ADR-0026. Desktop swaps its single Send
  // button for Cancel while a stream runs; web has two sections and so
  // one Cancel beside the status line, which is the same offer made once
  // instead of twice.
  describe("streaming", () => {
    const START = { type: "message_start", tokensIn: 12, model: "claude-x" };
    const STOP = { type: "message_stop", stopReason: "end_turn" };

    async function mountStreaming(props: Record<string, unknown> = baseProps) {
      const wrapper = await mountPanel(props);
      await wrapper.find("[data-testid='ai-stream-toggle']").setValue(true);
      return wrapper;
    }

    it("offers the toggle, unchecked, when the selected provider streams", async () => {
      const wrapper = await mountPanel();
      const toggle = wrapper.find<HTMLInputElement>("[data-testid='ai-stream-toggle']");
      expect(toggle.exists()).toBe(true);
      expect(toggle.element.checked).toBe(false);
      wrapper.unmount();
    });

    it("hides the toggle when the selected provider does not stream", async () => {
      const wrapper = await mountPanel(baseProps, ONE_NON_STREAMING_PROVIDER);
      expect(wrapper.find("[data-testid='ai-stream-toggle']").exists()).toBe(false);
      wrapper.unmount();
    });

    it("shows the toggle once a streaming provider is chosen", async () => {
      const wrapper = await mountPanel(baseProps, TWO_PROVIDERS);
      expect(wrapper.find("[data-testid='ai-stream-toggle']").exists()).toBe(false);

      await wrapper.find("[data-testid='ai-provider-select']").setValue("fast");

      expect(wrapper.find("[data-testid='ai-stream-toggle']").exists()).toBe(true);
      wrapper.unmount();
    });

    // ADR-0026 Decision 9: unchecked is bit-for-bit the deployment that
    // existed before this slice. Nothing about the request changes, and
    // the SSE transport is never reached.
    it("leaves the atomic route alone while the toggle is unchecked", async () => {
      const wrapper = await mountPanel();
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/explain", {
        method: "POST",
        body: { sql: "SELECT 1" },
      });
      expect(mockStream).not.toHaveBeenCalled();
      wrapper.unmount();
    });

    it("streams an explain and renders the answer as it arrives", async () => {
      const wrapper = await mountStreaming();
      mockStream.mockReturnValueOnce(
        streamOf([
          START,
          { type: "text_delta", text: "This " },
          { type: "text_delta", text: "selects 1." },
          STOP,
        ]),
      );

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(mockStream.mock.lastCall?.[0]).toBe("http://test/ai/explain/stream");
      expect(mockStream.mock.lastCall?.[1].body).toEqual({ sql: "SELECT 1" });
      expect(wrapper.find("[data-testid='ai-explain-output']").text()).toContain("This selects 1.");
      wrapper.unmount();
    });

    it("streams a suggest, carrying the same prompt and table list", async () => {
      const tables = [{ schema: "public", name: "users" }];
      const wrapper = await mountStreaming({ ...baseProps, tables });
      mockStream.mockReturnValueOnce(
        streamOf([START, { type: "text_delta", text: "SELECT 42;" }, STOP]),
      );

      await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("count users");
      await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
      await flushPromises();

      expect(mockStream.mock.lastCall?.[0]).toBe("http://test/ai/suggest/stream");
      expect(mockStream.mock.lastCall?.[1].body).toEqual({
        prompt: "count users",
        schema: tables,
      });
      expect(wrapper.find("[data-testid='ai-suggest-output']").text()).toContain("SELECT 42;");
      wrapper.unmount();
    });

    it("carries the dialect and the chosen provider into a streamed request", async () => {
      const wrapper = await mountPanel(baseProps, TWO_PROVIDERS);
      await wrapper.find("[data-testid='ai-provider-select']").setValue("fast");
      await wrapper.find("[data-testid='ai-stream-toggle']").setValue(true);
      mockStream.mockReturnValueOnce(streamOf([START, STOP]));

      await wrapper.find("[data-testid='ai-dialect-input']").setValue("postgres");
      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(mockStream.mock.lastCall?.[1].body).toEqual({
        sql: "SELECT 1",
        dialect: "postgres",
        provider: "fast",
      });
      wrapper.unmount();
    });

    // A toggle left checked while the user moves to a provider that does
    // not stream would otherwise send the streaming route anyway. The
    // toggle disappearing is not enough — the dispatch has to agree.
    it("falls back to the atomic route when the chosen provider stops streaming", async () => {
      const wrapper = await mountPanel(baseProps, TWO_PROVIDERS);
      await wrapper.find("[data-testid='ai-provider-select']").setValue("fast");
      await wrapper.find("[data-testid='ai-stream-toggle']").setValue(true);
      await wrapper.find("[data-testid='ai-provider-select']").setValue("deep");
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(mockStream).not.toHaveBeenCalled();
      expect(lastBody()).toEqual({ sql: "SELECT 1", provider: "deep" });
      wrapper.unmount();
    });

    it("renders the token meter the stream reports", async () => {
      const wrapper = await mountStreaming();
      mockStream.mockReturnValueOnce(
        streamOf([START, { type: "usage", tokensIn: 12, tokensOut: 34 }, STOP]),
      );

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      const meter = wrapper.find("[data-testid='ai-token-meter']");
      expect(meter.exists()).toBe(true);
      expect(meter.text()).toContain('ai.tokens.meter|{"tin":12,"tout":34}');
      wrapper.unmount();
    });

    it("shows no meter before anything has reported usage", async () => {
      const wrapper = await mountPanel();
      expect(wrapper.find("[data-testid='ai-token-meter']").exists()).toBe(false);
      wrapper.unmount();
    });

    // ADR-0026 Decision 10. Cancel is offered for as long as there is a
    // stream to stop, and only then: an atomic call has nothing behind
    // it that a click could interrupt.
    it("offers Cancel only while a stream is running", async () => {
      const wrapper = await mountStreaming();
      expect(wrapper.find("[data-testid='ai-cancel-button']").exists()).toBe(false);

      mockStream.mockImplementationOnce(hangingStream([START, { type: "text_delta", text: "Hi" }]));
      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(wrapper.find("[data-testid='ai-cancel-button']").exists()).toBe(true);
      expect(
        wrapper.find<HTMLButtonElement>("[data-testid='ai-explain-button']").element.disabled,
      ).toBe(true);

      await wrapper.find("[data-testid='ai-cancel-button']").trigger("click");
      await flushPromises();

      expect(wrapper.find("[data-testid='ai-cancel-button']").exists()).toBe(false);
      wrapper.unmount();
    });

    // ADR-0026 Decision 12. Cancelling is not failing: the partial answer
    // stays, and the panel says "Cancelled." rather than raising a banner
    // the user would read as something having gone wrong.
    it("keeps the partial answer and reports the cancel without an error banner", async () => {
      const wrapper = await mountStreaming();
      mockStream.mockImplementationOnce(
        hangingStream([START, { type: "text_delta", text: "This selects" }]),
      );

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();
      await wrapper.find("[data-testid='ai-cancel-button']").trigger("click");
      await flushPromises();

      const cancelled = wrapper.find("[data-testid='ai-cancelled']");
      expect(cancelled.exists()).toBe(true);
      expect(cancelled.text()).toContain("ai.state.cancelled");
      expect(wrapper.find("[data-testid='ai-error']").exists()).toBe(false);
      expect(wrapper.find("[data-testid='ai-explain-output']").text()).toContain("This selects");
      wrapper.unmount();
    });

    it("clears the cancelled line once the next stream starts", async () => {
      const wrapper = await mountStreaming();
      mockStream.mockImplementationOnce(hangingStream([START]));
      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();
      await wrapper.find("[data-testid='ai-cancel-button']").trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-testid='ai-cancelled']").exists()).toBe(true);

      mockStream.mockReturnValueOnce(
        streamOf([START, { type: "text_delta", text: "second" }, STOP]),
      );
      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(wrapper.find("[data-testid='ai-cancelled']").exists()).toBe(false);
      wrapper.unmount();
    });

    it("renders an error banner when the stream reports one in band", async () => {
      const wrapper = await mountStreaming();
      mockStream.mockReturnValueOnce(
        streamOf([START, { type: "error", category: "provider", message: "Upstream is down" }]),
      );

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      const banner = wrapper.find("[data-testid='ai-error']");
      expect(banner.exists()).toBe(true);
      expect(banner.text()).toContain("Upstream is down");
      expect(wrapper.find("[data-testid='ai-cancelled']").exists()).toBe(false);
      wrapper.unmount();
    });
  });
});
