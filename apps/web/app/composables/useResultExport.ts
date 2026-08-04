/**
 * The I/O half of result export (mirrors desktop ADR-0035, which uses the
 * egui clipboard and an `rfd` save dialog for the same two actions).
 * Serialization is pure and lives in `utils/export.ts`.
 *
 * Both paths are best-effort. `navigator.clipboard` is undefined outside a
 * secure context — which is how anyone running the API on a LAN box first
 * meets the copy button — and rejects when the permission is denied. Neither
 * is worth an exception: the result is still on screen, and the download path
 * still works.
 */
import { onBeforeUnmount, readonly, ref } from "vue";
import type { Column, Value } from "./useQueryExecution";
import { toCsvWithBom, toTsv } from "../utils/export";

export type ResultExportState = "idle" | "copied" | "failed";

/** How long the copy confirmation stays up. Long enough to read, short
 *  enough that it is gone before the next action. */
const CONFIRMATION_MS = 2000;

export function useResultExport() {
  const state = ref<ResultExportState>("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;

  function announce(next: ResultExportState) {
    state.value = next;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      state.value = "idle";
    }, CONFIRMATION_MS);
  }

  onBeforeUnmount(() => {
    // Firing into a torn-down component writes to a ref nothing owns any more.
    if (timer !== undefined) clearTimeout(timer);
  });

  async function copyTsv(
    columns: ReadonlyArray<Column>,
    rows: ReadonlyArray<ReadonlyArray<Value>>,
  ): Promise<void> {
    try {
      const clipboard = navigator.clipboard;
      if (clipboard === undefined) throw new Error("clipboard unavailable");
      await clipboard.writeText(toTsv(columns, rows));
      announce("copied");
    } catch {
      announce("failed");
    }
  }

  function downloadCsv(
    columns: ReadonlyArray<Column>,
    rows: ReadonlyArray<ReadonlyArray<Value>>,
    filename: string,
  ): void {
    // charset=utf-8 alongside the BOM: the header is what a browser preview
    // reads, the BOM is what Excel reads. Neither one covers both.
    const blob = new Blob([toCsvWithBom(columns, rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    // Firefox historically ignored a click on a detached anchor.
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      URL.revokeObjectURL(url);
    }
  }

  return { state: readonly(state), copyTsv, downloadCsv };
}
