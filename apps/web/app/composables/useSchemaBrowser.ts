/**
 * Backs the Phase 5 schema browser sidebar (issue 0017). Owns the
 * `GET /connections/:id/tables` fetch + lazy `LIMIT 0` column introspection
 * via the existing `POST /connections/:id/query` endpoint. Mirrors the
 * readonly-ref + `apiBase` resolution pattern of `useQueryHistory`.
 *
 * Column introspection deliberately goes through the existing query route
 * instead of a dedicated `/columns` endpoint so the HTTP contract stays
 * small and every adapter (Null / Postgres / future) gets the surface for
 * free — the result-set's `columns[]` metadata is what we render.
 */
import { onMounted, readonly, ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { apiFetch } from "./internal/http";
import { parseError, type CategorisedError } from "./internal/i18n-error";

export interface TableInfo {
  schema: string | null;
  name: string;
}

export interface ColumnInfo {
  name: string;
  declared_type: string;
}

export type SchemaState = "idle" | "loading" | "error";

interface ListTablesResponse {
  tables: TableInfo[];
}

interface QueryResponse {
  columns: ColumnInfo[];
  rows: unknown[];
  rows_affected: number;
}

export interface UseSchemaBrowserOptions {
  apiBase?: string;
}

function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

// SQL standard identifier quoting: wrap in "..." and double any embedded ".
// Same rule the desktop client applies (see ADR-0011) and what Postgres
// accepts for arbitrary identifiers.
export function quoteIdent(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

function buildLimitZeroSql(schema: string | null, table: string): string {
  const qualified =
    schema === null ? quoteIdent(table) : `${quoteIdent(schema)}.${quoteIdent(table)}`;
  return `SELECT * FROM ${qualified} LIMIT 0`;
}

export function useSchemaBrowser(connectionId: string, options?: UseSchemaBrowserOptions) {
  const apiBase = resolveApiBase(options?.apiBase);
  const tables = ref<ReadonlyArray<TableInfo>>([]);
  const state = ref<SchemaState>("idle");
  const lastError = ref<CategorisedError | null>(null);

  async function refresh(): Promise<void> {
    state.value = "loading";
    try {
      const res = await apiFetch<ListTablesResponse>(
        `${apiBase}/connections/${connectionId}/tables`,
      );
      tables.value = res.tables;
      state.value = "idle";
      lastError.value = null;
    } catch (err: unknown) {
      lastError.value = parseError(err);
      state.value = "error";
    }
  }

  async function loadColumns(schema: string | null, table: string): Promise<ColumnInfo[]> {
    const res = await apiFetch<QueryResponse>(`${apiBase}/connections/${connectionId}/query`, {
      method: "POST",
      body: { sql: buildLimitZeroSql(schema, table) },
    });
    return res.columns;
  }

  onMounted(() => {
    void refresh();
  });

  return {
    tables: readonly(tables),
    state: readonly(state),
    lastError: readonly(lastError),
    refresh,
    loadColumns,
  };
}
