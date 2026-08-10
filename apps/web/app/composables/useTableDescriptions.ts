/**
 * The AI panel's schema prefetch (ticket 0032 slice E, desktop ADR-0028
 * Decision 9). Answers two questions the panel cannot answer itself:
 * whether this connection can describe its tables at all, and — when the
 * user asks for column detail — what every table looks like.
 *
 * Separate from `useSchemaBrowser` even though both talk to
 * `GET /connections/:id/table-schema`. The sidebar describes one table
 * because a user expanded it; this describes all of them because a
 * Suggest is about to fire. Same route, different lifetime, and folding
 * them together would mean the sidebar owning a fan-out it never runs.
 */
import { onMounted, readonly, ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { apiFetch } from "./internal/http";
import type { TableInfo, TableSchema } from "./useSchemaBrowser";

/**
 * Matches desktop's `tokio::sync::Semaphore` budget for the same fan-out.
 * The point is the ceiling, not the number: a 200-table Postgres schema
 * must not open 200 connections at once because someone ticked a box.
 */
const MAX_CONCURRENT_DESCRIBES = 8;

export interface DescribeFanOut {
  /** The tables that answered, in the order they were asked about. */
  schemas: TableSchema[];
  /**
   * How many did not. A count rather than the failures themselves: the
   * panel says "n tables could not be described" and carries on, and
   * nothing downstream acts on *which* ones — the successes are the
   * payload, and a per-table error list would be a second thing to keep
   * in step for a message that never names them.
   */
  failed: number;
}

interface CapabilitiesResponse {
  id: string;
  capabilities: Record<string, boolean>;
}

export interface UseTableDescriptionsOptions {
  apiBase?: string;
}

function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

export function useTableDescriptions(connectionId: string, options?: UseTableDescriptionsOptions) {
  const apiBase = resolveApiBase(options?.apiBase);
  // False until the probe answers, and false if it never does. The panel
  // renders the toggle from this, and offering column detail we have not
  // been told exists would trade a greyed-out box for an error after
  // every Suggest (ADR-0028 Decision 4).
  const supported = ref(false);

  function describeOne(table: TableInfo): Promise<TableSchema> {
    // Identifiers go in the query string for the same reason the sidebar
    // puts them there: `/`, `?` and `#` are legal in a table name.
    const params = new URLSearchParams({ table: table.name });
    if (table.schema !== null) params.set("schema", table.schema);
    return apiFetch<TableSchema>(
      `${apiBase}/connections/${connectionId}/table-schema?${params.toString()}`,
    );
  }

  /**
   * Describes every table, at most {@link MAX_CONCURRENT_DESCRIBES} at a
   * time, and never rejects: a table that cannot be described is one the
   * model will not hear about, not a reason to withhold the Suggest.
   *
   * Nothing is cached (ADR-0028 Decision 7). A schema change on the
   * server has to reach the next Suggest, and a remembered description
   * would prompt the model with a table that no longer looks like that.
   */
  async function describeAll(tables: readonly TableInfo[]): Promise<DescribeFanOut> {
    // Written into by index rather than pushed, so the answers come back
    // in the order the tables were listed. Two identical prompts should
    // not differ by which describe happened to return first.
    const slots: Array<TableSchema | null> = tables.map(() => null);
    let failed = 0;
    let next = 0;

    async function worker(): Promise<void> {
      for (;;) {
        const index = next;
        next += 1;
        const table = tables[index];
        if (table === undefined) return;
        try {
          slots[index] = await describeOne(table);
        } catch {
          failed += 1;
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_DESCRIBES, tables.length) }, () => worker()),
    );

    return { schemas: slots.filter((slot): slot is TableSchema => slot !== null), failed };
  }

  onMounted(() => {
    void apiFetch<CapabilitiesResponse>(`${apiBase}/connections/${connectionId}/capabilities`)
      .then((res) => {
        supported.value = res.capabilities?.has_describe_table === true;
      })
      // An unreachable probe is not an error to show. The panel keeps
      // every other thing it does; it just cannot offer this one.
      .catch(() => {
        supported.value = false;
      });
  });

  return {
    supported: readonly(supported),
    describeAll,
  };
}
