import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { apiFetch } from "../app/composables/internal/http";
import { useSshHostKey } from "../app/composables/useSshHostKey";

vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

type ProbeApi = ReturnType<typeof useSshHostKey>;

function makeHarness(apiBase = "http://test") {
  const holder: { api: ProbeApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useSshHostKey({ apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

describe("useSshHostKey", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dials nothing on mount", async () => {
    // ADR-0076's whole point is that the probe is a button. Fetching a host
    // key because a form opened would dial whatever half-typed hostname is
    // in the box, and would make the identity check feel automatic when it
    // is the one step the operator is supposed to perform themselves.
    const { Component } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();

    expect(mockFetch).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("asks the bastion what key it presents, and hands the answer back", async () => {
    mockFetch.mockResolvedValueOnce({ fingerprint: "SHA256:abc" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    const returned = await holder.api!.probe("bastion.example.com", 2222);
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/connections/ssh/host-key", {
      method: "POST",
      body: { host: "bastion.example.com", port: 2222 },
    });
    // Returned as well as stored: the caller that pressed the button is the
    // one that decides whether it goes into the field.
    expect(returned).toBe("SHA256:abc");
    expect(holder.api!.fingerprint.value).toBe("SHA256:abc");
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("sends no port when none was typed, rather than inventing 22", async () => {
    // The default lives in `ProbeSshHostKey`, which is also where the tunnel
    // gets it. Two copies could drift, and a fingerprint fetched from one
    // port and pinned against a tunnel dialled at another compares two
    // different hosts' keys.
    mockFetch.mockResolvedValueOnce({ fingerprint: "SHA256:abc" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.probe("bastion.example.com");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/connections/ssh/host-key", {
      method: "POST",
      body: { host: "bastion.example.com" },
    });
    wrapper.unmount();
  });

  it("refuses a blank host without dialling anything", async () => {
    // A guaranteed 422, and worse than useless: the round trip would blank
    // the previous answer and report a server error for a form mistake.
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    const returned = await holder.api!.probe("   ");
    await flushPromises();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(returned).toBeNull();
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("drops the previous answer the moment a new probe starts", async () => {
    // A fingerprint on screen while a different host is being probed is the
    // one way this composable could get someone to pin the wrong key.
    mockFetch.mockResolvedValueOnce({ fingerprint: "SHA256:first" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await holder.api!.probe("first.example.com");
    await flushPromises();
    expect(holder.api!.fingerprint.value).toBe("SHA256:first");

    let release: (value: { fingerprint: string }) => void = () => {};
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = holder.api!.probe("second.example.com");
    await flushPromises();

    expect(holder.api!.fingerprint.value).toBeNull();
    expect(holder.api!.state.value).toBe("probing");

    release({ fingerprint: "SHA256:second" });
    await pending;
    expect(holder.api!.fingerprint.value).toBe("SHA256:second");
    wrapper.unmount();
  });

  it("reports a refused probe and keeps no fingerprint", async () => {
    mockFetch.mockRejectedValueOnce({
      data: {
        error: { category: "capability", message: "ssh probe failed: getaddrinfo ENOTFOUND" },
      },
    });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    const returned = await holder.api!.probe("nowhere.example.com");
    await flushPromises();

    expect(returned).toBeNull();
    expect(holder.api!.fingerprint.value).toBeNull();
    expect(holder.api!.state.value).toBe("error");
    expect(holder.api!.lastError.value?.category).toBe("capability");
    wrapper.unmount();
  });

  it("forgets an answer on request, for a form whose host box changed", async () => {
    // The fetched key belongs to the host that was in the box when the
    // button was pressed. Once that changes, showing it is a claim about a
    // host nobody probed.
    mockFetch.mockResolvedValueOnce({ fingerprint: "SHA256:abc" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await holder.api!.probe("bastion.example.com");
    await flushPromises();

    holder.api!.reset();

    expect(holder.api!.fingerprint.value).toBeNull();
    expect(holder.api!.lastError.value).toBeNull();
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });
});
