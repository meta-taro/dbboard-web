/**
 * The client half of `POST /connections/:id/rows` — ticket 0028 slice E.
 *
 * `grid-edit.ts` decides *what* to write (grouping staged cells into one
 * update per row, keyed on that row's primary key); this decides *how*, and
 * holds the two rules a user notices when they are wrong:
 *
 * - **One request per touched row.** The route writes a single row per call,
 *   and the API refuses any statement that matches a count other than one.
 * - **Stop at the first failure.** Half a save is worse than none the user
 *   can retry: the caller keeps its staged edits, so what has not been
 *   written is still on screen, still marked, and still theirs to fix.
 *
 * Desktop runs this loop inline in ResultGrid.svelte. Here it is a composable
 * so the loop is testable without mounting a grid — the same seam
 * `useAiAssist` uses, mocked at `internal/http` in tests.
 */
import { readonly, ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { apiFetch } from "./internal/http";
import { parseError, type CategorisedError } from "./internal/i18n-error";
import type { RowUpdate } from "../utils/grid-edit";
import type { TableInfo } from "./useSchemaBrowser";

export interface UseRowUpdateOptions {
  apiBase?: string;
}

/** What the route answers with. Read for its side effect of having been a
 *  2xx: the API already refused anything that did not match exactly one row,
 *  so a resolved promise is the whole result. */
interface WireUpdateRowResponse {
  rows_affected: number;
}

// Resolved when a save is attempted, not when the composable is created. A
// read-only grid holds one of these and never writes through it, and asking
// for the runtime config would make the whole component require a Nuxt app
// just to display rows. Safe to defer: a save only ever starts from a click
// in the browser, where the Nuxt instance is a client-lifetime singleton.
function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

export function useRowUpdate(options?: UseRowUpdateOptions) {
  const saving = ref(false);
  const lastError = ref<CategorisedError | null>(null);

  /**
   * Write every update in order, and report whether all of them landed.
   *
   * Returns `false` on the first failure, leaving {@link lastError} set and
   * the remaining updates unsent. Also returns `false` — without sending
   * anything — when a save is already in flight, because Save is a button
   * the user can double-click and each request is a write.
   */
  async function applyUpdates(
    connectionId: string,
    table: TableInfo,
    updates: ReadonlyArray<RowUpdate>,
  ): Promise<boolean> {
    if (saving.value) return false;
    if (updates.length === 0) return true;

    const apiBase = resolveApiBase(options?.apiBase);
    saving.value = true;
    try {
      for (const update of updates) {
        await apiFetch<WireUpdateRowResponse>(`${apiBase}/connections/${connectionId}/rows`, {
          method: "POST",
          body: bodyFor(table, update),
        });
      }
      lastError.value = null;
      return true;
    } catch (err: unknown) {
      lastError.value = parseError(err);
      return false;
    } finally {
      saving.value = false;
    }
  }

  /** Forget the last failure. For a caller that has thrown the edits away —
   *  an error about a write that will never be retried is a red box with no
   *  way to clear it. */
  function reset(): void {
    lastError.value = null;
  }

  return {
    saving: readonly(saving),
    lastError: readonly(lastError),
    applyUpdates,
    reset,
  };
}

// `schema` is omitted rather than sent as null when the table has none:
// absent means "the engine's default" to the adapter, and the DTO rejects a
// present-but-empty string. Sending one would turn a default into a 422.
function bodyFor(table: TableInfo, update: RowUpdate): Record<string, unknown> {
  const body: Record<string, unknown> = {
    table: table.name,
    key: update.key,
    edits: update.edits,
  };
  if (table.schema !== null) body.schema = table.schema;
  return body;
}
