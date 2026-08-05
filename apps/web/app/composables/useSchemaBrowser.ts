/**
 * Backs the Phase 5 schema browser sidebar (issue 0017). Owns the
 * `GET /connections/:id/tables` fetch + lazy `LIMIT 0` column introspection
 * via the existing `POST /connections/:id/query` endpoint. Mirrors the
 * readonly-ref + `apiBase` resolution pattern of `useQueryHistory`.
 *
 * Column introspection takes whichever of two paths the connection can
 * support (issue 0026). A connection that advertises `has_describe_table`
 * gets `GET /connections/:id/table-schema`, which reports primary keys,
 * nullability and defaults. Everything else keeps the original `LIMIT 0`
 * probe through `POST /connections/:id/query`: it needs no capability at
 * all, because the result-set's own `columns[]` metadata is the answer.
 *
 * The shallow path stays rather than being replaced. It is the only thing
 * that works against an adapter that cannot introspect, and it is what
 * keeps the sidebar useful on every driver.
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
  declared_type: string | null;
  // Only the describe route can fill these in. They are optional rather
  // than defaulted so a caller can tell "this column has no primary key"
  // from "this connection cannot tell us about primary keys" — rendering
  // the second as the first would be a confident lie.
  nullable?: boolean;
  primary_key?: boolean;
  ordinal?: number;
  default_value?: string | null;
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

interface CapabilitiesResponse {
  id: string;
  capabilities: Record<string, boolean>;
}

interface TableSchemaResponse {
  table: TableInfo;
  columns: ColumnInfo[];
  primary_key: string[];
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

  // Memoised as the promise, not the answer, so two tables expanded in the
  // same tick share one probe instead of racing two. A connection's
  // capabilities do not change under it, so once is enough.
  let describeProbe: Promise<boolean> | null = null;

  function supportsDescribe(): Promise<boolean> {
    describeProbe ??= apiFetch<CapabilitiesResponse>(
      `${apiBase}/connections/${connectionId}/capabilities`,
    )
      .then((res) => res.capabilities?.has_describe_table === true)
      // An unreachable probe is not a reason to show nothing. The shallow
      // path still works, so degrade to it.
      .catch(() => false);
    return describeProbe;
  }

  async function loadColumns(schema: string | null, table: string): Promise<ColumnInfo[]> {
    if (await supportsDescribe()) {
      // Identifiers go in the query string, where `/`, `?` and `#` are just
      // characters — see the route's own note on why not a path segment.
      const params = new URLSearchParams({ table });
      if (schema !== null) params.set("schema", schema);
      const res = await apiFetch<TableSchemaResponse>(
        `${apiBase}/connections/${connectionId}/table-schema?${params.toString()}`,
      );
      // No fallback on failure: the route was chosen because it works here,
      // so its error is the real one. Retrying through LIMIT 0 would only
      // restate it less clearly.
      return res.columns;
    }
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
