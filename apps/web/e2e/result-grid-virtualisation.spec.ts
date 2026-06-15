/**
 * End-to-end: the ResultGrid's @tanstack/vue-virtual virtualizer keeps
 * the DOM row pool tiny relative to the result-set size.
 *
 * Asserted bounds:
 *   - With 500 rows mocked, the DOM contains at most ~30 row nodes
 *     (overscan 8 + ~22 visible rows at 36 px row height on a Pixel 5
 *     viewport's 60vh scroll surface).
 *   - At least one row IS rendered (no regression to "zero rows" state).
 *   - Scrolling to the bottom of `.grid-scroll` brings the last row's
 *     formatted cell text into view.
 *
 * If a future refactor removes virtualisation, the rendered-row count
 * approaches 500 and this spec fails.
 */

import { expect, gotoApp, mockApi, test } from "./fixtures";

const TOTAL_ROWS = 500;
const MAX_RENDERED_ROWS = 30;

test.describe("ResultGrid virtualisation", () => {
  test("renders far fewer DOM rows than the 500-row payload", async ({ page }) => {
    const rows: ReadonlyArray<ReadonlyArray<number | string>> = Array.from(
      { length: TOTAL_ROWS },
      (_, i) => [i, `row-${i}`],
    );

    await mockApi(page, {
      initialConnections: [{ id: "mock-conn-1", label: "Local Postgres", driver: "postgres" }],
      queryResponse: {
        columns: [
          { name: "id", declared_type: "integer" },
          { name: "label", declared_type: "text" },
        ],
        rows,
        rows_affected: TOTAL_ROWS,
      },
    });

    await gotoApp(page, "/connections/mock-conn-1/sql");
    await page.getByTestId("sql-input").fill("SELECT id, label FROM huge;");
    await page.getByTestId("run-button").click();

    const grid = page.getByTestId("result-grid");
    await expect(grid).toBeVisible();

    const renderedRows = await page.getByTestId("result-grid__row").count();
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThanOrEqual(MAX_RENDERED_ROWS);

    // Scroll the virtual viewport to the bottom — the virtualizer should
    // mount the tail rows on demand.
    await grid.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    await expect(
      page.locator('[data-testid="result-grid__cell"]', { hasText: `row-${TOTAL_ROWS - 1}` }),
    ).toBeVisible();
  });
});
