/**
 * Owns the `POST /connections/:id/query` HTTP I/O for the Phase 4 SQL
 * editor page.
 *
 * Mirrors useConnections's shape: explicit Vue imports (mountable in
 * plain happy-dom without booting `@nuxt/test-utils`), readonly wrappers
 * on the public surface, the wire-underscore -> hyphen i18n bridge from
 * the shared internal/i18n-error module.
 *
 * Run is user-initiated only. There is no `onMounted` auto-run.
 */
import { readonly, ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { apiFetch } from "./internal/http";
import type { TableInfo } from "./useSchemaBrowser";
import { parseError, type CategorisedError } from "./internal/i18n-error";

export type BlobValue = { $blob: string };

// The payload of a `$json` cell, per docs/api-contract.md § Value. Plain JSON
// and deliberately *not* a nested `Value`: the contract calls the payload
// opaque, so a document that happens to hold a `$blob` key is that document.
// Typing it as `Value` would invite the grid to walk in looking for tags.
export type JsonPayload =
  | null
  | boolean
  | number
  | string
  | JsonPayload[]
  | { [key: string]: JsonPayload };
export type JsonValue = { $json: JsonPayload };

export type Value = null | number | string | BlobValue | JsonValue;

export interface Column {
  name: string;
  declared_type: string | null;
}

export interface QueryResult {
  columns: ReadonlyArray<Column>;
  rows: ReadonlyArray<ReadonlyArray<Value>>;
  rows_affected: number;
}

export type QueryExecutionState = "idle" | "loading" | "error";

export interface UseQueryExecutionOptions {
  apiBase?: string;
}

function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  // Mirrors useConnections — see note there.
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

export function useQueryExecution(connectionId: string, options?: UseQueryExecutionOptions) {
  const apiBase = resolveApiBase(options?.apiBase);
  const result = ref<QueryResult | null>(null);
  const state = ref<QueryExecutionState>("idle");
  const lastError = ref<CategorisedError | null>(null);
  // Provenance for `result`, not for the editor's text (ticket 0028).
  // Editability is decided by where a grid came from, because a `SELECT`
  // cannot be trusted to name the table it reads — so only a caller that
  // *generated* the SQL, knowing the table, may set this.
  const sourceTable = ref<TableInfo | null>(null);

  async function run(sql: string, source: TableInfo | null = null): Promise<void> {
    state.value = "loading";
    try {
      const res = await apiFetch<QueryResult>(`${apiBase}/connections/${connectionId}/query`, {
        method: "POST",
        body: { sql },
      });
      result.value = res;
      sourceTable.value = source;
      state.value = "idle";
      lastError.value = null;
    } catch (err: unknown) {
      // Leave `result` untouched so the user keeps seeing the last
      // successful payload while the error banner explains what went
      // wrong with the most recent attempt. `sourceTable` describes that
      // payload, so it has to stay in lockstep — clearing it here would
      // mislabel a grid that is still on screen.
      lastError.value = parseError(err);
      state.value = "error";
    }
  }

  return {
    result: readonly(result),
    sourceTable: readonly(sourceTable),
    state: readonly(state),
    lastError: readonly(lastError),
    run,
  };
}
