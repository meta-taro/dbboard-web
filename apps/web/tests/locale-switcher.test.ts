import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createSSRApp, nextTick, ref } from "vue";
import { renderToString } from "vue/server-renderer";
import LocaleSwitcher from "../app/components/LocaleSwitcher.vue";

const locale = ref("en");
const setLocale = vi.fn(async (next: string) => {
  locale.value = next;
});

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    locale,
    setLocale,
    t: (key: string) => key,
  }),
}));

describe("LocaleSwitcher", () => {
  it("lists every supported locale by its own name", () => {
    locale.value = "en";
    const wrapper = mount(LocaleSwitcher);

    const codes = wrapper.findAll("option").map((o) => o.attributes("value"));
    expect(codes).toContain("ja");
    expect(codes).toContain("pt-BR");
    expect(wrapper.find('option[value="ja"]').text()).toBe("日本語");
  });

  it("hands the chosen code to setLocale", async () => {
    locale.value = "en";
    setLocale.mockClear();
    const wrapper = mount(LocaleSwitcher);

    await wrapper.find("select").setValue("ja");

    expect(setLocale).toHaveBeenCalledWith("ja");
  });

  // Hydration, not a fresh mount, is where this broke. A `:value` binding on
  // a `<select>` is a DOM property and the server has no DOM, so it went out
  // as `value="ja"` — an attribute HTML ignores on `<select>` — and hydration
  // left it alone because the attribute already matched. The live page ran
  // in Japanese (`<html lang="ja">`, Japanese strings throughout) while the
  // switcher said "English".
  //
  // A client-only mount cannot catch it: Vue mounts an element's children
  // before its props precisely so `select.value` can find its option, so the
  // broken binding worked there. Hydrate the server's own markup instead and
  // assert what the user sees.
  it("shows the current locale after hydrating the server markup", async () => {
    locale.value = "ja";
    const html = await renderToString(createSSRApp(LocaleSwitcher));

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    createSSRApp(LocaleSwitcher).mount(container);
    await nextTick();

    const select = container.querySelector("select")!;
    expect(select.value).toBe("ja");
    expect(select.selectedIndex).toBe(1);

    container.remove();
  });
});
