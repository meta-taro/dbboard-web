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
import { dialectFor, qualifiedName, type SqlDialect } from "../utils/sql-build";
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

/**
 * A column as `GET /connections/:id/table-schema` reports it: every field
 * filled in, because that route only exists on adapters that can answer
 * all of them (ADR-0028 Decision 5).
 *
 * A separate type from `ColumnInfo` rather than a tightening of it. The
 * optionality above is load-bearing for the shallow `LIMIT 0` path, and
 * the AI's `full_schema` needs the opposite guarantee — the API rejects a
 * half-described column rather than prompt the model with one.
 */
export interface DescribedColumn {
  name: string;
  declared_type: string | null;
  nullable: boolean;
  primary_key: boolean;
  ordinal: number;
  default_value: string | null;
}

/** One described table — the describe route's whole answer. */
export interface TableSchema {
  table: TableInfo;
  columns: DescribedColumn[];
  primary_key: string[];
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

export interface UseSchemaBrowserOptions {
  apiBase?: string;
  /**
   * The connection's driver, used only to pick the identifier quoting of the
   * `LIMIT 0` probe (ADR-0072). Absent means "not known yet", which resolves
   * to ANSI — the page mounts this before the connection list has arrived.
   *
   * A getter is accepted, and is what a page should pass: the driver is read
   * out of an in-flight `GET /connections`, so it is usually still unknown
   * when this composable is constructed. Reading a plain string once at
   * setup would pin ANSI for the session and break every MySQL sidebar whose
   * connection list resolved a tick later.
   */
  driver?: string | (() => string | null | undefined);
}

function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

function buildLimitZeroSql(schema: string | null, table: string, dialect: SqlDialect): string {
  return `SELECT * FROM ${qualifiedName({ schema, name: table }, dialect)} LIMIT 0`;
}

export function useSchemaBrowser(connectionId: string, options?: UseSchemaBrowserOptions) {
  const apiBase = resolveApiBase(options?.apiBase);
  // Resolved per call, not once at setup: the driver may still be loading.
  function currentDialect(): SqlDialect {
    const driver = typeof options?.driver === "function" ? options.driver() : options?.driver;
    return dialectFor(driver);
  }
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
      const res = await apiFetch<TableSchema>(
        `${apiBase}/connections/${connectionId}/table-schema?${params.toString()}`,
      );
      // No fallback on failure: the route was chosen because it works here,
      // so its error is the real one. Retrying through LIMIT 0 would only
      // restate it less clearly.
      return res.columns;
    }
    const res = await apiFetch<QueryResponse>(`${apiBase}/connections/${connectionId}/query`, {
      method: "POST",
      body: { sql: buildLimitZeroSql(schema, table, currentDialect()) },
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
