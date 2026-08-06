import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import RestorePanel from "../app/components/RestorePanel.vue";
import { rawFetch } from "../app/composables/internal/download";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
  }),
}));

vi.mock("../app/composables/internal/download", () => ({
  rawFetch: vi.fn(),
  saveBlob: vi.fn(),
}));

const mockFetch = vi.mocked(rawFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function planBody(overrides: Record<string, unknown> = {}) {
  return {
    statements_total: 4,
    ddl_count: 2,
    data_count: 2,
    unparsed_count: 0,
    existing_tables: [],
    is_target_empty: true,
    ...overrides,
  };
}

function outcomeBody(overrides: Record<string, unknown> = {}) {
  return {
    statements_run: 4,
    ddl_run: 2,
    data_run: 2,
    failures: [],
    cancelled: false,
    atomic: true,
    ...overrides,
  };
}

function mountPanel() {
  return mount(RestorePanel, { props: { connectionId: "c1", apiBase: "http://test" } });
}

// jsdom's file input is read-only, so the component takes the chosen file
// through a `change` event carrying a stand-in with the one method it calls.
function fileEvent(text: string, name = "seed.sql"): Event {
  const file = { name, text: () => Promise.resolve(text) };
  const event = new Event("change");
  Object.defineProperty(event, "target", { value: { files: [file] } });
  return event;
}

const SCRIPT = "CREATE TABLE t (id int);\n";

async function choose(wrapper: ReturnType<typeof mountPanel>, text = SCRIPT, name = "seed.sql") {
  wrapper.get('[data-testid="restore__file"]').element.dispatchEvent(fileEvent(text, name));
  await flushPromises();
}

describe("RestorePanel", () => {
  afterEach(() => {
    mockFetch.mockReset();
    vi.restoreAllMocks();
  });

  it("shows only the file chooser before a file is picked", () => {
    const wrapper = mountPanel();

    expect(wrapper.find('[data-testid="restore__file"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="restore__summary"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="restore__run"]').exists()).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("preflights the chosen file and shows what will run", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    const wrapper = mountPanel();

    await choose(wrapper);

    expect(mockFetch.mock.calls[0]![0]).toBe("http://test/connections/c1/restore/plan");
    const summary = wrapper.get('[data-testid="restore__summary"]').text();
    expect(summary).toContain('"statements":4');
    expect(summary).toContain('"ddl":2');
    expect(summary).toContain('"data":2');
    expect(wrapper.get('[data-testid="restore__run"]').attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("blocks the run behind a checkbox when the target is not empty", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(planBody({ existing_tables: ["public.a", "public.b"], is_target_empty: false })),
    );
    const wrapper = mountPanel();

    await choose(wrapper);

    expect(wrapper.get('[data-testid="restore__nonempty-warn"]').text()).toContain('"tables":2');
    expect(wrapper.get('[data-testid="restore__run"]').attributes("disabled")).toBeDefined();

    await wrapper.get('[data-testid="restore__confirm"]').setValue(true);

    expect(wrapper.get('[data-testid="restore__run"]').attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("warns about statements the classifier could not parse", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody({ unparsed_count: 3 })));
    const wrapper = mountPanel();

    await choose(wrapper);

    expect(wrapper.get('[data-testid="restore__unparsed-warn"]').text()).toContain('"count":3');
    wrapper.unmount();
  });

  it("hides both warnings for a clean plan into an empty target", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    const wrapper = mountPanel();

    await choose(wrapper);

    expect(wrapper.find('[data-testid="restore__nonempty-warn"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="restore__unparsed-warn"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="restore__confirm"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("runs the restore and reports the outcome", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    mockFetch.mockResolvedValueOnce(jsonResponse(outcomeBody()));
    const wrapper = mountPanel();

    await choose(wrapper);
    await wrapper.get('[data-testid="restore__run"]').trigger("click");
    await flushPromises();

    expect(mockFetch.mock.calls[1]![0]).toBe(
      "http://test/connections/c1/restore?confirmed=false&on_error=stop",
    );
    const done = wrapper.get('[data-testid="restore__outcome"]').text();
    // Atomic gets its own sentence — "as one batch" is the reassurance.
    expect(done).toContain("restore.doneAtomic");
    expect(done).toContain('"statements":4');
    wrapper.unmount();
  });

  it("sends the chosen on-error policy", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    mockFetch.mockResolvedValueOnce(jsonResponse(outcomeBody()));
    const wrapper = mountPanel();

    await choose(wrapper);
    await wrapper.get('[data-testid="restore__onerror"]').setValue("continue");
    await wrapper.get('[data-testid="restore__run"]').trigger("click");
    await flushPromises();

    expect(mockFetch.mock.calls[1]![0]).toBe(
      "http://test/connections/c1/restore?confirmed=false&on_error=continue",
    );
    wrapper.unmount();
  });

  it("names the failures of a partial run", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        outcomeBody({
          statements_run: 3,
          atomic: false,
          failures: [{ index: 2, message: 'relation "t" does not exist' }],
        }),
      ),
    );
    const wrapper = mountPanel();

    await choose(wrapper);
    await wrapper.get('[data-testid="restore__run"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="restore__outcome"]').text()).toContain("restore.done|");
    expect(wrapper.get('[data-testid="restore__failures"]').text()).toContain('"count":1');
    wrapper.unmount();
  });

  it("offers cancel while running, and nothing else", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    mockFetch.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const wrapper = mountPanel();

    await choose(wrapper);
    await wrapper.get('[data-testid="restore__run"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="restore__run"]').exists()).toBe(false);
    await wrapper.get('[data-testid="restore__cancel"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="restore__outcome"]').text()).toContain("restore.cancelled");
    expect(wrapper.find('[data-testid="restore__error"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows a failed preflight in the error slot", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { category: "capability", message: "unknown connection: c1" } }, 404),
    );
    const wrapper = mountPanel();

    await choose(wrapper);

    expect(wrapper.get('[data-testid="restore__error"]').text()).toContain("unknown connection");
    expect(wrapper.find('[data-testid="restore__run"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("starts over when the user picks a different file", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody({ statements_total: 4 })));
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody({ statements_total: 9 })));
    const wrapper = mountPanel();

    await choose(wrapper, SCRIPT, "first.sql");
    await choose(wrapper, "SELECT 1;", "second.sql");

    expect(wrapper.get('[data-testid="restore__summary"]').text()).toContain('"statements":9');
    expect(wrapper.get('[data-testid="restore__filename"]').text()).toContain("second.sql");
    wrapper.unmount();
  });

  it("ignores a change event that carries no file", async () => {
    const wrapper = mountPanel();
    const event = new Event("change");
    Object.defineProperty(event, "target", { value: { files: [] } });

    wrapper.get('[data-testid="restore__file"]').element.dispatchEvent(event);
    await flushPromises();

    expect(mockFetch).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
