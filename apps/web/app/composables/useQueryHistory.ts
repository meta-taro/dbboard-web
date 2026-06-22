/**
 * Owns the `GET /history/export.jsonl` HTTP I/O for the Phase 5 history
 * sidebar (issue 0015). Mirrors the readonly-ref + `apiBase` resolution
 * pattern of `useConnections` / `useQueryExecution`.
 *
 * The endpoint is an operator-only NDJSON egress per ADR-0017 §8 and the
 * `.claude/decisions.md` "2026-06-05" entry; the web UI consumes it from
 * the same origin. The composable returns text from `apiFetch<string>`
 * because Nuxt's underlying `$fetch` returns the response body as a
 * string when the response Content-Type is `application/x-ndjson` (it
 * only auto-parses JSON). The text is split via the shared
 * `parseNdjson` and gated by a local type-guard so the web bundle does
 * not have to pull Zod just to validate this shape.
 */
import { onMounted, readonly, ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { apiFetch } from "./internal/http";
import { parseError, type CategorisedError } from "./internal/i18n-error";
import { parseNdjson } from "./internal/parse-ndjson";

export type HistoryStatus = "ok" | "error";

export interface HistoryErrorEnvelope {
  category: "connection" | "query" | "schema" | "type_conversion" | "capability";
  message: string;
}

// Mirrors apps/api/src/domain/history-record.ts (ADR-0017 §2). Duplicated
// as a TypeScript type because the web app does not import from apps/api.
export interface HistoryRecord {
  v: 1;
  ts: string;
  conn: string;
  actor: string | null;
  sql: string;
  status: HistoryStatus;
  duration_ms: number;
  rows: number | null;
  rows_affected: number | null;
  error: HistoryErrorEnvelope | null;
}

export type HistoryState = "idle" | "loading" | "error";

export interface UseQueryHistoryOptions {
  apiBase?: string;
}

function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  // Mirrors useConnections — see note there about the explicit #imports edge.
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

// Defensive guard: drop anything that does not look like an ADR-0017 v=1
// record. We deliberately do not run the full Zod schema here — the API
// side already validated on write, and the wire shape is stable. This
// catches the forward-compat cases (`v: 2`, unknown `status`) without
// bringing the Zod runtime into the web bundle for one validator.
function validateHistoryRecord(v: unknown): HistoryRecord | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.ts !== "string") return null;
  if (typeof r.conn !== "string" || r.conn === "") return null;
  if (r.actor !== null && typeof r.actor !== "string") return null;
  if (typeof r.sql !== "string") return null;
  if (r.status !== "ok" && r.status !== "error") return null;
  if (typeof r.duration_ms !== "number") return null;
  if (r.rows !== null && typeof r.rows !== "number") return null;
  if (r.rows_affected !== null && typeof r.rows_affected !== "number") return null;
  if (r.error !== null && (typeof r.error !== "object" || r.error === null)) return null;
  return {
    v: 1,
    ts: r.ts,
    conn: r.conn,
    actor: r.actor as string | null,
    sql: r.sql,
    status: r.status,
    duration_ms: r.duration_ms,
    rows: r.rows as number | null,
    rows_affected: r.rows_affected as number | null,
    error: r.error as HistoryErrorEnvelope | null,
  };
}

export function useQueryHistory(connectionId: string, options?: UseQueryHistoryOptions) {
  const apiBase = resolveApiBase(options?.apiBase);
  const history = ref<ReadonlyArray<HistoryRecord>>([]);
  const state = ref<HistoryState>("idle");
  const lastError = ref<CategorisedError | null>(null);

  async function refresh(): Promise<void> {
    state.value = "loading";
    try {
      const text = await apiFetch<string>(`${apiBase}/history/export.jsonl`, {
        headers: { Accept: "application/x-ndjson" },
      });
      const all = parseNdjson<HistoryRecord>(text, validateHistoryRecord);
      const filtered = all
        .filter((r) => r.conn === connectionId)
        .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
      history.value = filtered;
      state.value = "idle";
      lastError.value = null;
    } catch (err: unknown) {
      lastError.value = parseError(err);
      state.value = "error";
    }
  }

  onMounted(() => {
    void refresh();
  });

  return {
    history: readonly(history),
    state: readonly(state),
    lastError: readonly(lastError),
    refresh,
  };
}
