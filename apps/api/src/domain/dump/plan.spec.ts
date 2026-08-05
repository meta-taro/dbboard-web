import { describe, expect, it } from "vitest";
import { ROW_CAP } from "../limits";
import type { TableInfo } from "../values/table-info";
import {
  DEFAULT_BACKUP_WARN_ROWS,
  INSERT_BATCH_ROWS,
  READ_PAGE_ROWS,
  exceedsThreshold,
  totalRows,
  type DumpPlan,
} from "./plan";

function planOf(counts: number[]): DumpPlan {
  return {
    tables: counts.map((rowCount, i) => ({
      table: { schema: null, name: `t${i}` } as TableInfo,
      rowCount,
    })),
  };
}

describe("dump paging constants", () => {
  it("keeps a read page under the per-query row cap", () => {
    // The cap belongs to ExecuteQuery, which dump does not go through — but
    // a page larger than it would be the one size in the codebase nobody
    // could reason about. Staying under keeps the number honest.
    expect(READ_PAGE_ROWS).toBeLessThan(ROW_CAP);
  });

  it("keeps an INSERT batch inside a read page and under SQLite's 500", () => {
    // 500 is SQLite's default compound-SELECT limit. Web ships no SQLite
    // adapter, but a dump is a file a human may load anywhere.
    expect(INSERT_BATCH_ROWS).toBeLessThanOrEqual(500);
    expect(INSERT_BATCH_ROWS).toBeLessThanOrEqual(READ_PAGE_ROWS);
  });
});

describe("totalRows", () => {
  it("sums the per-table counts", () => {
    expect(totalRows(planOf([10, 20, 5]))).toBe(35);
  });

  it("is zero for a plan with no tables", () => {
    expect(totalRows({ tables: [] })).toBe(0);
  });
});

describe("exceedsThreshold", () => {
  it("does not fire below or exactly at the threshold", () => {
    expect(exceedsThreshold(planOf([DEFAULT_BACKUP_WARN_ROWS - 1]))).toBeNull();
    expect(exceedsThreshold(planOf([DEFAULT_BACKUP_WARN_ROWS]))).toBeNull();
  });

  it("fires one row over, reporting the total", () => {
    expect(exceedsThreshold(planOf([DEFAULT_BACKUP_WARN_ROWS + 1]))).toBe(
      DEFAULT_BACKUP_WARN_ROWS + 1,
    );
  });

  it("sums across tables rather than looking at the largest one", () => {
    expect(exceedsThreshold(planOf([300_000, 300_000]))).toBe(600_000);
  });

  it("accepts an explicit threshold", () => {
    expect(exceedsThreshold(planOf([10]), 9)).toBe(10);
    expect(exceedsThreshold(planOf([10]), 10)).toBeNull();
  });
});
