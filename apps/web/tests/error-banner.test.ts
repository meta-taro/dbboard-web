import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ErrorBanner from "../app/components/ErrorBanner.vue";
import { displayError, plainError } from "../app/utils/display-error";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const BILINGUAL = displayError("クエリエラー: boom", "Query error: boom");

function mountBanner(error = BILINGUAL, props: Record<string, unknown> = {}) {
  return mount(ErrorBanner, { props: { error, ...props } });
}

describe("ErrorBanner", () => {
  it("shows the localized message", () => {
    const wrapper = mountBanner();

    expect(wrapper.text()).toContain("クエリエラー: boom");
    wrapper.unmount();
  });

  it("shows the English original on a second line when it differs", () => {
    const wrapper = mountBanner();

    expect(wrapper.find("[data-testid='error-banner__original']").text()).toBe("Query error: boom");
    wrapper.unmount();
  });

  // Desktop ADR-0039: the original line is there to add something. On an
  // English UI it would repeat the line above it, which reads as a bug.
  it("omits the second line when it would repeat the first", () => {
    const wrapper = mountBanner(plainError("Passphrases do not match"));

    expect(wrapper.find("[data-testid='error-banner__original']").exists()).toBe(false);
    expect(wrapper.text()).toContain("Passphrases do not match");
    wrapper.unmount();
  });

  it("announces the error to assistive technology", () => {
    const wrapper = mountBanner();

    expect(wrapper.get("[role='alert']").text()).toContain("クエリエラー: boom");
    wrapper.unmount();
  });

  describe("copying", () => {
    function stubClipboard(writeText: () => Promise<void>) {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
    }

    it("copies both halves, so the English is what gets pasted into a search", async () => {
      const writeText = vi.fn(async () => {});
      stubClipboard(writeText);

      const wrapper = mountBanner();
      await wrapper.find("[data-testid='error-banner__copy']").trigger("click");

      expect(writeText).toHaveBeenCalledWith("クエリエラー: boom\nQuery error: boom");
      wrapper.unmount();
    });

    it("acknowledges the copy, because a copy leaves nothing on screen to notice", async () => {
      stubClipboard(async () => {});

      const wrapper = mountBanner();
      await wrapper.find("[data-testid='error-banner__copy']").trigger("click");
      await Promise.resolve();
      await wrapper.vm.$nextTick();

      expect(wrapper.find("[data-testid='error-banner__status']").text()).toBe("error.copied");
      wrapper.unmount();
    });

    it("says so when the clipboard refuses, rather than looking like success", async () => {
      stubClipboard(async () => {
        throw new Error("denied");
      });

      const wrapper = mountBanner();
      await wrapper.find("[data-testid='error-banner__copy']").trigger("click");
      await Promise.resolve();
      await wrapper.vm.$nextTick();

      expect(wrapper.find("[data-testid='error-banner__status']").text()).toBe("error.copy-failed");
      wrapper.unmount();
    });

    // Text changing inside a `role="alert"` re-announces the whole alert. A
    // screen reader user pressing Copy would hear the error read out again.
    it("keeps the acknowledgement outside the alert", async () => {
      stubClipboard(async () => {});

      const wrapper = mountBanner();
      await wrapper.find("[data-testid='error-banner__copy']").trigger("click");
      await Promise.resolve();
      await wrapper.vm.$nextTick();

      expect(wrapper.get("[role='alert']").text()).not.toContain("error.copied");
      expect(wrapper.get("[data-testid='error-banner__status']").attributes("role")).toBe("status");
      wrapper.unmount();
    });

    // Rendered from the start rather than appearing with its text: a live
    // region created at the same moment it gains content is not reliably
    // announced.
    it("renders the live region before there is anything to say", () => {
      const wrapper = mountBanner();

      const status = wrapper.find("[data-testid='error-banner__status']");
      expect(status.exists()).toBe(true);
      expect(status.text()).toBe("");
      wrapper.unmount();
    });
  });
});
