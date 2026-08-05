/**
 * Decides whether the grid on screen is editable, and against what — ticket
 * 0028 slice E. The web mirror of desktop `QueryPanel.svelte`'s `editTable` /
 * `editPk` pair.
 *
 * Two rules, both of which are the whole reason this is a composable rather
 * than three refs on the page:
 *
 * - **Provenance decides, never SQL.** A table arrives here only because the
 *   schema browser said "browse this one". Text the user typed arrives as
 *   `null` and stays read-only forever. Nothing here inspects a query.
 * - **"No primary key" and "we could not ask" are different answers.** Both
 *   leave the grid read-only, but only the first is something we can tell the
 *   user. A failed or unsupported describe means *unknown*, and unknown says
 *   nothing — the same distinction `ColumnInfo`'s optional fields draw.
 *
 * Desktop swallows the describe error and treats it as an empty key, which
 * conflates the two. This one keeps them apart, so the read-only note only
 * appears when it is true.
 */
import { computed, readonly, ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { apiFetch } from "./internal/http";
import type { EditContext } from "../utils/grid-edit";
import type { ColumnInfo, TableInfo } from "./useSchemaBrowser";

export interface UseEditContextOptions {
  apiBase?: string;
}

/** `GET /connections/:id/table-schema`. Only `primary_key` is read here —
 *  the sidebar already owns the column list. */
interface TableSchemaResponse {
  table: TableInfo;
  columns: ColumnInfo[];
  primary_key: string[];
}

// Resolved per request rather than at construction, for the same reason
// `useRowUpdate` defers it: a page that never browses a table never asks the
// runtime config for anything, and a bare mount in a test stays possible.
function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

export function useEditContext(connectionId: string, options?: UseEditContextOptions) {
  const table = ref<TableInfo | null>(null);
  const pk = ref<string[]>([]);
  /** Whether the current table's key is *known*. False both before the answer
   *  arrives and after one that never came. */
  const described = ref(false);

  const noPk = computed(() => described.value && pk.value.length === 0);

  const context = computed<EditContext | null>(() => {
    const source = table.value;
    if (source === null || pk.value.length === 0) return null;
    return { connectionId, table: { schema: source.schema, name: source.name }, pk: [...pk.value] };
  });

  // Bumped by every call so a slow answer cannot land on the grid that
  // replaced it. Browsing two tables in quick succession is one click each,
  // and the wrong key silently writes to the wrong row.
  let generation = 0;

  /**
   * Point the edit context at `source`, or clear it when `source` is `null`.
   *
   * Resolves once the answer is in, but callers do not need to await it: the
   * key is cleared synchronously, so the grid is read-only for the whole
   * window between the query landing and its schema arriving.
   */
  async function load(source: TableInfo | null): Promise<void> {
    const mine = ++generation;
    table.value = source;
    pk.value = [];
    described.value = false;
    if (source === null) return;

    const apiBase = resolveApiBase(options?.apiBase);
    // Identifiers go in the query string, where `/`, `?` and `#` are just
    // characters — the same reason the route does not take a path segment.
    const params = new URLSearchParams({ table: source.name });
    if (source.schema !== null) params.set("schema", source.schema);

    try {
      const res = await apiFetch<TableSchemaResponse>(
        `${apiBase}/connections/${connectionId}/table-schema?${params.toString()}`,
      );
      if (mine !== generation) return;
      pk.value = res.primary_key;
      described.value = true;
    } catch {
      // Read-only, and quietly so. A connection that cannot introspect is not
      // a connection whose tables have no keys, and the rows are still on
      // screen and still worth reading.
      if (mine !== generation) return;
      pk.value = [];
      described.value = false;
    }
  }

  return {
    table: readonly(table),
    pk: readonly(pk),
    /** True only when a *successful* describe reported no key columns. */
    noPk,
    context,
    load,
  };
}
