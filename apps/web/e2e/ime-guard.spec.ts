/**
 * End-to-end: the IME composition guard in the SQL editor MUST suppress
 * `Ctrl+Enter` while an IME candidate is being committed.
 *
 * Two paths are covered:
 *   1. Modern engines emit `isComposing: true` on the keydown that
 *      commits the candidate.
 *   2. Safari and older Android WebViews emit `keyCode: 229` without
 *      setting `isComposing`.
 *
 * Neither must dispatch the query (asserted via `state.queryCalls === 0`).
 * As a regression guard we also confirm the non-IME `Ctrl+Enter` still
 * fires the run.
 *
 * happy-dom (the unit suite's environment) does not model IME composition
 * semantics, so this contract can only be verified on a real Chromium —
 * which is precisely why slice 4 exists.
 */

import { expect, gotoApp, mockApi, test } from "./fixtures";

test.describe("SQL editor IME composition guard", () => {
  test("suppresses Ctrl+Enter under isComposing AND legacy keyCode 229", async ({ page }) => {
    const api = await mockApi(page, {
      initialConnections: [{ id: "mock-conn-1", label: "Local Postgres", driver: "postgres" }],
    });

    await gotoApp(page, "/connections/mock-conn-1/sql");
    const editor = page.getByTestId("sql-input");
    await expect(editor).toBeVisible();
    await editor.fill("SELECT 1;");
    await editor.focus();

    // Modern IME-commit keydown: isComposing: true.
    await page.evaluate(() => {
      const target = document.querySelector<HTMLTextAreaElement>('[data-testid="sql-input"]');
      if (!target) throw new Error("sql-input missing");
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          ctrlKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Legacy Safari / Android: keyCode 229 sentinel. KeyboardEvent's
    // constructor init dict is honoured inconsistently across engines for
    // the deprecated keyCode field, so defineProperty after construction
    // is the belt-and-braces fallback.
    await page.evaluate(() => {
      const target = document.querySelector<HTMLTextAreaElement>('[data-testid="sql-input"]');
      if (!target) throw new Error("sql-input missing");
      const ev = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(ev, "keyCode", { get: () => 229 });
      target.dispatchEvent(ev);
    });

    // Neither IME-suppressed path may have fired the mocked POST.
    expect(api.queryCalls).toBe(0);
    await expect(page.getByTestId("result-summary")).toBeHidden();

    // Regression guard: the regular (non-IME) Ctrl+Enter still works.
    await page.evaluate(() => {
      const target = document.querySelector<HTMLTextAreaElement>('[data-testid="sql-input"]');
      if (!target) throw new Error("sql-input missing");
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    await expect(page.getByTestId("result-summary")).toBeVisible();
    expect(api.queryCalls).toBe(1);
  });
});
