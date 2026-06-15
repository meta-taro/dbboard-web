/**
 * End-to-end: register a connection, navigate to the SQL editor, run a
 * mocked query, and confirm the virtualised result grid renders.
 *
 * This is the critical path Phase 4 slices 1-3 wired up. On the `mobile`
 * project we additionally assert every touch target in the path is the
 * Phase 1.5 DoD-required >= 44 x 44 px.
 */

import { expect, gotoApp, mockApi, test } from "./fixtures";

test.describe("connection registration -> SQL editor -> grid render", () => {
  test("registers a connection, runs a query, renders the grid", async ({ page }, testInfo) => {
    const api = await mockApi(page);

    await gotoApp(page, "/connections");
    await expect(page.getByTestId("add-form")).toBeVisible();

    await page.getByTestId("label-input").fill("Local Postgres");
    await page.getByTestId("driver-input").selectOption("postgres");
    await page.getByTestId("connection-string-input").fill("postgres://localhost/mock");
    await page.getByTestId("add-submit").click();

    await expect(page.getByTestId("connection-row")).toHaveCount(1);
    expect(api.registerCalls).toBe(1);

    const runSqlLink = page.getByTestId("run-sql-link");
    await expect(runSqlLink).toBeVisible();

    // Touch-target assertion captured BEFORE the navigation: the link
    // disappears once we leave /connections.
    if (testInfo.project.name === "mobile") {
      const linkBox = await runSqlLink.boundingBox();
      expect(linkBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(linkBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await runSqlLink.click();
    await expect(page).toHaveURL(/\/connections\/mock-conn-1\/sql$/);
    await expect(page.getByTestId("sql-input")).toBeVisible();

    await page.getByTestId("sql-input").fill("SELECT id, label FROM things;");
    const runButton = page.getByTestId("run-button");
    await runButton.click();

    await expect(page.getByTestId("result-summary")).toBeVisible();
    await expect(page.getByTestId("result-grid")).toBeVisible();
    await expect(page.getByTestId("result-grid__row")).toHaveCount(2);
    await expect(page.getByTestId("result-grid__column-header").first()).toHaveText("id");
    expect(api.queryCalls).toBe(1);

    if (testInfo.project.name === "mobile") {
      const runBtnBox = await runButton.boundingBox();
      expect(runBtnBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(runBtnBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});
