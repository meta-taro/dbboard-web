import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import DumpButton from "../app/components/DumpButton.vue";
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

function sqlResponse(): Response {
  return new Response("-- dump\n", {
    status: 200,
    headers: { "Content-Disposition": 'attachment; filename="dbboard-dump-c1.sql"' },
  });
}

function refusal(message = "this database holds 600000 rows"): Response {
  return new Response(JSON.stringify({ error: { category: "query", message } }), { status: 400 });
}

function mountButton() {
  return mount(DumpButton, { props: { connectionId: "c1", apiBase: "http://test" } });
}

describe("DumpButton", () => {
  afterEach(() => {
    mockFetch.mockReset();
    vi.restoreAllMocks();
  });

  it("downloads the dump on click", async () => {
    const { saveBlob } = await import("../app/composables/internal/download");
    mockFetch.mockResolvedValue(sqlResponse());
    const wrapper = mountButton();

    await wrapper.get('[data-testid="dump__download"]').trigger("click");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/connections/c1/dump");
    expect(saveBlob).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("disables the button while the dump is running", async () => {
    let release: ((res: Response) => void) | undefined;
    mockFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const wrapper = mountButton();

    await wrapper.get('[data-testid="dump__download"]').trigger("click");
    await flushPromises();
    const button = wrapper.get('[data-testid="dump__download"]');
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.text()).toBe("dump.running");

    release!(sqlResponse());
    await flushPromises();
    expect(wrapper.get('[data-testid="dump__download"]').attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("asks before dumping a database over the size gate", async () => {
    mockFetch.mockResolvedValue(refusal());
    const wrapper = mountButton();

    await wrapper.get('[data-testid="dump__download"]').trigger("click");
    await flushPromises();

    const prompt = wrapper.get('[data-testid="dump__confirm"]');
    expect(prompt.text()).toContain("dump.confirm.prompt");
    // The server's sentence names the row count, so it is shown verbatim
    // alongside the translated question.
    expect(prompt.text()).toContain("600000");
    expect(wrapper.find('[data-testid="dump__error"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("re-sends confirmed when the prompt is accepted", async () => {
    mockFetch.mockResolvedValueOnce(refusal()).mockResolvedValueOnce(sqlResponse());
    const wrapper = mountButton();

    await wrapper.get('[data-testid="dump__download"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="dump__confirm-accept"]').trigger("click");
    await flushPromises();

    expect(mockFetch).toHaveBeenLastCalledWith("http://test/connections/c1/dump?confirm=true");
    expect(wrapper.find('[data-testid="dump__confirm"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("drops the prompt when it is declined, without dumping", async () => {
    mockFetch.mockResolvedValue(refusal());
    const wrapper = mountButton();

    await wrapper.get('[data-testid="dump__download"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="dump__confirm-cancel"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="dump__confirm"]').exists()).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("shows a failure with its translated category prefix", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { category: "capability", message: "no DDL" } }), {
        status: 404,
      }),
    );
    const wrapper = mountButton();

    await wrapper.get('[data-testid="dump__download"]').trigger("click");
    await flushPromises();

    const error = wrapper.get('[data-testid="dump__error"]');
    expect(error.text()).toContain("error.prefix.capability");
    expect(error.text()).toContain("no DDL");
    wrapper.unmount();
  });

  // A live region inserted at the same moment it gains text is not reliably
  // announced, so the status element is present from the start.
  it("keeps a polite live region mounted from the start", () => {
    const wrapper = mountButton();
    const status = wrapper.get('[data-testid="dump__status"]');

    expect(status.attributes("role")).toBe("status");
    expect(status.attributes("aria-live")).toBe("polite");
    expect(status.text()).toBe("");
    wrapper.unmount();
  });
});
