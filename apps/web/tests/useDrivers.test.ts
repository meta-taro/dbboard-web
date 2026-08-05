import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { apiFetch } from "../app/composables/internal/http";
import { useDrivers } from "../app/composables/useDrivers";

vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

type DriversApi = ReturnType<typeof useDrivers>;

function makeHarness(apiBase = "http://test") {
  const holder: { api: DriversApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useDrivers({ apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

describe("useDrivers", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the server what it can connect with, on mount", async () => {
    mockFetch.mockResolvedValueOnce({ drivers: ["postgres", "null"] });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/connections/drivers");
    expect(holder.api!.drivers.value).toEqual(["postgres", "null"]);
    expect(holder.api!.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("keeps the server's order rather than sorting it", async () => {
    // The first entry becomes the form's default selection, so the order is
    // a decision the factory makes and this must not overwrite.
    mockFetch.mockResolvedValueOnce({ drivers: ["postgres", "mysql", "null"] });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();

    expect(holder.api!.drivers.value).toEqual(["postgres", "mysql", "null"]);
    wrapper.unmount();
  });

  it("leaves the list empty and reports the failure when the request fails", async () => {
    // Empty is the honest answer: guessing `["postgres"]` here would put an
    // option in front of the user that this build may not support, which is
    // the failure the whole slice removes.
    mockFetch.mockRejectedValueOnce(new Error("network down"));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();

    expect(holder.api!.drivers.value).toEqual([]);
    expect(holder.api!.lastError.value).not.toBeNull();
    wrapper.unmount();
  });

  it("asks once per mount, not once per read", async () => {
    // The set of compiled-in drivers cannot change while the page is open,
    // so re-fetching it alongside every list refresh would be noise.
    mockFetch.mockResolvedValueOnce({ drivers: ["postgres"] });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();

    expect(holder.api!.drivers.value).toEqual(["postgres"]);
    expect(holder.api!.drivers.value).toEqual(["postgres"]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
