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
import { apiFetch } from "./internal/http";
import { parseError, type CategorisedError } from "./internal/i18n-error";

export type BlobValue = { $blob: string };
export type Value = null | number | string | BlobValue;

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
  const cfg = (
    globalThis as unknown as {
      useRuntimeConfig?: () => { public: { apiBaseUrl: string } };
    }
  ).useRuntimeConfig;
  return cfg?.().public.apiBaseUrl ?? "";
}

export function useQueryExecution(connectionId: string, options?: UseQueryExecutionOptions) {
  const apiBase = resolveApiBase(options?.apiBase);
  const result = ref<QueryResult | null>(null);
  const state = ref<QueryExecutionState>("idle");
  const lastError = ref<CategorisedError | null>(null);

  async function run(sql: string): Promise<void> {
    state.value = "loading";
    try {
      const res = await apiFetch<QueryResult>(`${apiBase}/connections/${connectionId}/query`, {
        method: "POST",
        body: { sql },
      });
      result.value = res;
      state.value = "idle";
      lastError.value = null;
    } catch (err: unknown) {
      // Leave `result` untouched so the user keeps seeing the last
      // successful payload while the error banner explains what went
      // wrong with the most recent attempt.
      lastError.value = parseError(err);
      state.value = "error";
    }
  }

  return {
    result: readonly(result),
    state: readonly(state),
    lastError: readonly(lastError),
    run,
  };
}
