import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ResultGrid from "../app/components/ResultGrid.vue";
import { apiFetch } from "../app/composables/internal/http";

// Ticket 0028 slice E — the editing half of the grid, mirroring desktop's
// ResultGrid.svelte. The read-only half is tested in result-grid.test.ts and
// stays exactly as it was: with no `edit` prop the grid must not gain a
// single affordance.

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
  }),
}));

vi.mock("@tanstack/vue-virtual", async () => ({
  useVirtualizer: (await import("./helpers/virtualizer")).fakeUseVirtualizer,
}));

vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

const RESULT = {
  columns: [
    { name: "id", declared_type: "INTEGER" },
    { name: "email", declared_type: "TEXT" },
    { name: "bio", declared_type: "TEXT" },
    { name: "avatar", declared_type: "BYTEA" },
  ],
  rows: [
    [1, "ann@example.com", "short", { $blob: "AAAA" }],
    [2, "bob@example.com", null, { $blob: "BBBB" }],
  ],
  rows_affected: 0,
} as const;

const EDIT = {
  connectionId: "c1",
  table: { schema: "public", name: "users" },
  pk: ["id"],
};

const ID = 0;
const EMAIL = 1;
const BIO = 2;
const AVATAR = 3;

function mountGrid(overrides: Record<string, unknown> = {}) {
  return mount(ResultGrid, {
    props: { result: RESULT, edit: EDIT, apiBase: "http://test", ...overrides },
  });
}

type Wrapper = ReturnType<typeof mountGrid>;

/** The `<td>` at a display row and column. Display order is insertion order
 *  here, because nothing is sorted unless a test sorts it. */
function cell(wrapper: Wrapper, row: number, column: number) {
  const rows = wrapper.findAll("[data-testid='result-grid__row']");
  return rows[row]!.findAll("[data-testid='result-grid__cell']")[column]!;
}

async function beginEdit(wrapper: Wrapper, row: number, column: number) {
  await cell(wrapper, row, column).trigger("dblclick");
  return wrapper.find("[data-testid='result-grid__cell-input']");
}

async function stage(wrapper: Wrapper, row: number, column: number, value: string) {
  const input = await beginEdit(wrapper, row, column);
  await input.setValue(value);
  await input.trigger("keydown", { key: "Enter" });
}

describe("ResultGrid editing", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("when the result is read-only", () => {
    it("shows no edit bar and opens no editor", async () => {
      const wrapper = mount(ResultGrid, { props: { result: RESULT } });

      await cell(wrapper, 0, EMAIL).trigger("dblclick");

      expect(wrapper.find("[data-testid='result-grid__edit-bar']").exists()).toBe(false);
      expect(wrapper.find("[data-testid='result-grid__cell-input']").exists()).toBe(false);
      wrapper.unmount();
    });
  });

  describe("opening an editor", () => {
    it("double-click puts the cell's current text in an inline input", async () => {
      const wrapper = mountGrid();

      const input = await beginEdit(wrapper, 0, EMAIL);

      expect(input.exists()).toBe(true);
      expect((input.element as HTMLInputElement).value).toBe("ann@example.com");
      wrapper.unmount();
    });

    it("starts a NULL cell as empty text, not as the word NULL", async () => {
      // The draft is what will be written. Pre-filling it with "NULL" would
      // make the obvious edit — type over it — write the four letters.
      const wrapper = mountGrid();

      const input = await beginEdit(wrapper, 1, BIO);

      expect((input.element as HTMLInputElement).value).toBe("");
      wrapper.unmount();
    });

    it("refuses a primary-key column, which is what the UPDATE is keyed on", async () => {
      const wrapper = mountGrid();

      const input = await beginEdit(wrapper, 0, ID);

      expect(input.exists()).toBe(false);
      wrapper.unmount();
    });

    it("refuses a blob, which the grid never had the bytes of", async () => {
      const wrapper = mountGrid();

      const input = await beginEdit(wrapper, 0, AVATAR);

      expect(input.exists()).toBe(false);
      wrapper.unmount();
    });

    // Desktop refuses both tagged shapes for two different reasons: a blob is
    // bytes the grid never had, a document is a tree that a free-text edit
    // could leave unparseable. The editor writes text and only text.
    it("refuses a document, which a free-text edit could leave unparseable", async () => {
      const wrapper = mountGrid({
        result: {
          columns: [...RESULT.columns, { name: "meta", declared_type: "JSONB" }],
          rows: [[1, "ann@example.com", "short", { $blob: "AAAA" }, { $json: { a: 1 } }]],
          rows_affected: 0,
        },
      });

      const input = await beginEdit(wrapper, 0, 4);

      expect(input.exists()).toBe(false);
      wrapper.unmount();
    });

    it("sends a value too wide for the inline box straight to the dialog", async () => {
      // Opening a 40-character slot onto 500 characters of prose is not an
      // editor — desktop's rule, and the reason both share one predicate.
      const long = "x".repeat(80);
      const wrapper = mountGrid({
        result: { ...RESULT, rows: [[1, "a@example.com", long, { $blob: "" }]] },
      });

      await cell(wrapper, 0, BIO).trigger("dblclick");

      expect(wrapper.find("[data-testid='result-grid__cell-input']").exists()).toBe(false);
      expect(wrapper.find("[data-testid='cell-editor']").exists()).toBe(true);
      wrapper.unmount();
    });
  });

  describe("staging", () => {
    it("Enter commits the draft, and the cell shows it as pending", async () => {
      const wrapper = mountGrid();

      await stage(wrapper, 0, EMAIL, "new@example.com");

      expect(cell(wrapper, 0, EMAIL).text()).toBe("new@example.com");
      expect(cell(wrapper, 0, EMAIL).classes()).toContain("cell--dirty");
      expect(wrapper.find("[data-testid='result-grid__edit-count']").text()).toContain(
        '{"count":1}',
      );
      wrapper.unmount();
    });

    it("blur commits too — clicking away is not a way to lose the edit", async () => {
      const wrapper = mountGrid();

      const input = await beginEdit(wrapper, 0, EMAIL);
      await input.setValue("blurred@example.com");
      await input.trigger("blur");

      expect(cell(wrapper, 0, EMAIL).text()).toBe("blurred@example.com");
      wrapper.unmount();
    });

    it("Escape cancels, staging nothing", async () => {
      const wrapper = mountGrid();

      const input = await beginEdit(wrapper, 0, EMAIL);
      await input.setValue("discarded@example.com");
      await input.trigger("keydown", { key: "Escape" });

      expect(cell(wrapper, 0, EMAIL).text()).toBe("ann@example.com");
      expect(wrapper.find("[data-testid='result-grid__edit-bar']").exists()).toBe(false);
      wrapper.unmount();
    });

    it("the NULL button stages a NULL, which is not the same as empty text", async () => {
      const wrapper = mountGrid();

      await beginEdit(wrapper, 0, EMAIL);
      await wrapper.find("[data-testid='result-grid__cell-null']").trigger("mousedown");

      expect(cell(wrapper, 0, EMAIL).text()).toBe("NULL");
      expect(cell(wrapper, 0, EMAIL).classes()).toContain("cell--dirty");
      wrapper.unmount();
    });

    it("the revert button puts the cell back and clears the edit bar", async () => {
      const wrapper = mountGrid();

      await stage(wrapper, 0, EMAIL, "new@example.com");
      await beginEdit(wrapper, 0, EMAIL);
      await wrapper.find("[data-testid='result-grid__cell-revert']").trigger("mousedown");

      expect(cell(wrapper, 0, EMAIL).text()).toBe("ann@example.com");
      expect(wrapper.find("[data-testid='result-grid__edit-bar']").exists()).toBe(false);
      wrapper.unmount();
    });

    it("offers no revert on a cell that has nothing staged", async () => {
      const wrapper = mountGrid();

      await beginEdit(wrapper, 0, EMAIL);

      expect(wrapper.find("[data-testid='result-grid__cell-revert']").exists()).toBe(false);
      wrapper.unmount();
    });

    it("Discard clears every staged cell", async () => {
      const wrapper = mountGrid();

      await stage(wrapper, 0, EMAIL, "a@example.com");
      await stage(wrapper, 1, EMAIL, "b@example.com");
      await wrapper.find("[data-testid='result-grid__discard']").trigger("click");

      expect(wrapper.find("[data-testid='result-grid__edit-bar']").exists()).toBe(false);
      expect(cell(wrapper, 0, EMAIL).text()).toBe("ann@example.com");
      wrapper.unmount();
    });

    it("drops staging when the result is replaced", async () => {
      // A new result is new rows: an edit staged against row 0 of the old one
      // would silently be an edit to a different row.
      const wrapper = mountGrid();

      await stage(wrapper, 0, EMAIL, "new@example.com");
      await wrapper.setProps({ result: { ...RESULT, rows: [[9, "z@example.com", null, null]] } });

      expect(wrapper.find("[data-testid='result-grid__edit-bar']").exists()).toBe(false);
      wrapper.unmount();
    });
  });

  describe("the dialog", () => {
    it("hands the inline draft over, so nothing is retyped", async () => {
      const wrapper = mountGrid();

      const input = await beginEdit(wrapper, 0, EMAIL);
      await input.setValue("half-typed");
      await wrapper.find("[data-testid='result-grid__cell-expand']").trigger("mousedown");

      const area = wrapper.find("[data-testid='cell-editor__input']");
      expect((area.element as HTMLTextAreaElement).value).toBe("half-typed");
      wrapper.unmount();
    });

    it("applies a multi-line value the inline input could not have held", async () => {
      const wrapper = mountGrid();

      await beginEdit(wrapper, 0, EMAIL);
      await wrapper.find("[data-testid='result-grid__cell-expand']").trigger("mousedown");
      await wrapper.find("[data-testid='cell-editor__input']").setValue("line one\nline two");
      await wrapper.find("[data-testid='cell-editor__apply']").trigger("click");

      expect(cell(wrapper, 0, EMAIL).classes()).toContain("cell--dirty");
      await wrapper.find("[data-testid='result-grid__save']").trigger("click");
      await flushPromises();
      const body = mockFetch.mock.calls[0]![1]!.body as { edits: Array<{ value: unknown }> };
      expect(body.edits[0]!.value).toBe("line one\nline two");
      wrapper.unmount();
    });

    it("cancels without staging — a dialog opened by accident writes nothing", async () => {
      const wrapper = mountGrid();

      await beginEdit(wrapper, 0, EMAIL);
      await wrapper.find("[data-testid='result-grid__cell-expand']").trigger("mousedown");
      await wrapper.find("[data-testid='cell-editor__input']").setValue("typed but abandoned");
      await wrapper.find("[data-testid='cell-editor__cancel']").trigger("click");

      expect(wrapper.find("[data-testid='cell-editor']").exists()).toBe(false);
      expect(cell(wrapper, 0, EMAIL).text()).toBe("ann@example.com");
      wrapper.unmount();
    });
  });

  describe("saving", () => {
    it("writes one request per touched row, keyed on that row's primary key", async () => {
      mockFetch.mockResolvedValue({ rows_affected: 1 });
      const wrapper = mountGrid();

      await stage(wrapper, 0, EMAIL, "a@example.com");
      await stage(wrapper, 1, EMAIL, "b@example.com");
      await wrapper.find("[data-testid='result-grid__save']").trigger("click");
      await flushPromises();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(1, "http://test/connections/c1/rows", {
        method: "POST",
        body: {
          table: "users",
          schema: "public",
          key: [{ column: "id", value: 1 }],
          edits: [{ column: "email", value: "a@example.com" }],
        },
      });
      wrapper.unmount();
    });

    it("clears staging and asks the page to reload once every row landed", async () => {
      mockFetch.mockResolvedValue({ rows_affected: 1 });
      const wrapper = mountGrid();

      await stage(wrapper, 0, EMAIL, "a@example.com");
      await wrapper.find("[data-testid='result-grid__save']").trigger("click");
      await flushPromises();

      expect(wrapper.find("[data-testid='result-grid__edit-bar']").exists()).toBe(false);
      expect(wrapper.emitted("saved")).toHaveLength(1);
      wrapper.unmount();
    });

    it("flushes an open editor first, so the last edit is not left behind", async () => {
      mockFetch.mockResolvedValue({ rows_affected: 1 });
      const wrapper = mountGrid();

      const input = await beginEdit(wrapper, 0, EMAIL);
      await input.setValue("unconfirmed@example.com");
      await wrapper.find("[data-testid='result-grid__save']").trigger("mousedown");
      await wrapper.find("[data-testid='result-grid__save']").trigger("click");
      await flushPromises();

      const body = mockFetch.mock.calls[0]![1]!.body as { edits: Array<{ value: unknown }> };
      expect(body.edits[0]!.value).toBe("unconfirmed@example.com");
      wrapper.unmount();
    });

    it("keeps the staged edits when the write fails, and says why", async () => {
      mockFetch.mockRejectedValue({
        data: { error: { category: "query", message: "no row matched" } },
      });
      const wrapper = mountGrid();

      await stage(wrapper, 0, EMAIL, "a@example.com");
      await wrapper.find("[data-testid='result-grid__save']").trigger("click");
      await flushPromises();

      expect(wrapper.find("[data-testid='result-grid__edit-error']").text()).toContain(
        "no row matched",
      );
      expect(cell(wrapper, 0, EMAIL).classes()).toContain("cell--dirty");
      expect(wrapper.emitted("saved")).toBeUndefined();
      wrapper.unmount();
    });

    it("refuses an unkeyed table without sending anything", async () => {
      // The refusal comes from buildRowUpdates, and it names the fix. Sending
      // an unkeyed UPDATE would rewrite the table.
      const wrapper = mountGrid({ edit: { ...EDIT, pk: [] } });

      await stage(wrapper, 0, EMAIL, "a@example.com");
      await wrapper.find("[data-testid='result-grid__save']").trigger("click");
      await flushPromises();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(wrapper.find("[data-testid='result-grid__edit-error']").text()).toContain(
        "no primary key",
      );
      wrapper.unmount();
    });
  });

  describe("sorting", () => {
    it("keeps a staged edit on its own row when the display order changes", async () => {
      // The rule the whole staging map exists for: edits are keyed on the
      // original row index, so a re-sort moves the tint with the row.
      mockFetch.mockResolvedValue({ rows_affected: 1 });
      const wrapper = mountGrid();

      await stage(wrapper, 1, EMAIL, "bob-new@example.com");
      // Sort descending by id: two clicks on the header (asc, then desc).
      const header = wrapper.findAll("[data-testid='result-grid__sort-button']")[ID]!;
      await header.trigger("click");
      await header.trigger("click");

      expect(cell(wrapper, 0, ID).text()).toBe("2");
      expect(cell(wrapper, 0, EMAIL).text()).toBe("bob-new@example.com");
      expect(cell(wrapper, 1, EMAIL).classes()).not.toContain("cell--dirty");

      await wrapper.find("[data-testid='result-grid__save']").trigger("click");
      await flushPromises();
      const body = mockFetch.mock.calls[0]![1]!.body as { key: Array<{ value: unknown }> };
      expect(body.key[0]!.value).toBe(2);
      wrapper.unmount();
    });
  });
});
