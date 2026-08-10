<script setup lang="ts">
import { computed, reactive } from "vue";
import ErrorBanner from "./ErrorBanner.vue";
import { useSchemaBrowser, type ColumnInfo, type TableInfo } from "../composables/useSchemaBrowser";
import { prefixed } from "../utils/display-error";
import { BROWSE_ROWS, dialectFor, qualifiedName, quoteIdent, selectTopN } from "../utils/sql-build";

interface Props {
  connectionId: string;
  apiBase?: string;
  /**
   * The connection's driver, used only to pick identifier quoting (ADR-0072).
   * Optional because the page mounts this panel before the connection list
   * has arrived; `undefined` resolves to ANSI, which is what every driver
   * except MySQL accepts.
   */
  driver?: string;
}

const props = defineProps<Props>();
// Two verbs, deliberately different in kind. `insert` hands the editor a
// name to write SQL around; `browse` hands it a whole statement *plus* the
// table it came from, because that provenance — not the SQL text — is what
// decides whether the resulting grid is editable (ticket 0028).
const emit = defineEmits<{
  (event: "insert", text: string): void;
  (event: "browse", payload: { sql: string; table: TableInfo }): void;
}>();

const { t } = useI18n();
const { tables, state, lastError, refresh, loadColumns } = useSchemaBrowser(props.connectionId, {
  apiBase: props.apiBase,
  // A getter, not `props.driver`: the page reads the driver out of an
  // in-flight connection list, so it is usually still absent at mount.
  driver: () => props.driver,
});

const dialect = computed(() => dialectFor(props.driver));

interface GroupView {
  key: string;
  label: string;
  rawSchema: string | null;
  tables: TableInfo[];
}

const groups = computed<GroupView[]>(() => {
  const buckets = new Map<string, GroupView>();
  for (const table of tables.value) {
    const key = table.schema ?? "__null__";
    const existing = buckets.get(key);
    if (existing) {
      existing.tables.push(table);
    } else {
      buckets.set(key, {
        key,
        label: table.schema ?? t("schema.default-schema"),
        rawSchema: table.schema,
        tables: [table],
      });
    }
  }
  return Array.from(buckets.values());
});

const isLoading = computed(() => state.value === "loading");

interface ColumnEntry {
  state: "idle" | "loading" | "loaded" | "error";
  columns: ColumnInfo[];
}

// Lazy-load + cache. Keyed by `${schema}|${name}` so two tables with the same
// name in different schemas keep separate buckets.
const columnCache = reactive<Record<string, ColumnEntry>>({});

function cacheKey(schema: string | null, name: string): string {
  return `${schema ?? ""}|${name}`;
}

async function onToggleTable(table: TableInfo) {
  // Cache-guarded: a closed → open toggle and the subsequent open → closed
  // toggle both fire here, but we only ever fetch once per table per
  // session (re-fetch on error). Avoids depending on `event.target.open`,
  // which test environments do not populate before the toggle event.
  const key = cacheKey(table.schema, table.name);
  const existing = columnCache[key];
  if (existing && existing.state !== "error") return;
  columnCache[key] = { state: "loading", columns: [] };
  try {
    const columns = await loadColumns(table.schema, table.name);
    columnCache[key] = { state: "loaded", columns };
  } catch {
    columnCache[key] = { state: "error", columns: [] };
  }
}

function onInsertTable(table: TableInfo) {
  emit("insert", qualifiedName(table, dialect.value));
}

function onBrowseTable(table: TableInfo) {
  emit("browse", { sql: selectTopN(table, BROWSE_ROWS, dialect.value), table });
}

function onInsertColumn(column: ColumnInfo) {
  emit("insert", quoteIdent(column.name, dialect.value));
}

function columnEntry(table: TableInfo): ColumnEntry | undefined {
  return columnCache[cacheKey(table.schema, table.name)];
}

// The three below read `undefined` as "unknown", not as "no". A connection
// that cannot introspect leaves these fields absent, and a column with no
// badge means we were not told — not that the column is nullable and
// keyless. Only the describe route can populate them (issue 0026).
function isPrimaryKey(column: ColumnInfo): boolean {
  return column.primary_key === true;
}

function isNotNull(column: ColumnInfo): boolean {
  return column.nullable === false;
}

function defaultOf(column: ColumnInfo): string | null {
  return column.default_value ?? null;
}

// Expose the fetched list so the page can hand it to the AI panel
// (ticket 0032 slice A). Read-only on purpose: this component owns the
// fetch, and a second owner would mean two lists that can disagree. It
// is the sidebar's ref, so the panel sees the tables appear as they land
// rather than a snapshot taken at mount.
// `state` travels with the list because the list alone is ambiguous: it is
// `[]` while the fetch is out and `[]` after it failed, and neither of
// those is "this connection has no tables".
defineExpose({ tables, state });
</script>

<template>
  <aside data-testid="schema-browser" class="schema-browser">
    <header class="header">
      <h3 class="title">{{ t("schema.heading") }}</h3>
      <button
        type="button"
        data-testid="schema-refresh"
        class="refresh-button"
        :disabled="isLoading"
        @click="refresh()"
      >
        {{ t("schema.refresh") }}
      </button>
    </header>

    <ErrorBanner
      v-if="lastError"
      data-testid="schema-error"
      dense
      :error="prefixed('schema.error.load', lastError.message, t)"
    />

    <p v-if="groups.length === 0 && !lastError" data-testid="schema-empty" class="empty">
      {{ t("schema.empty") }}
    </p>

    <ul v-else class="groups">
      <li v-for="group in groups" :key="group.key" class="group-item">
        <details data-testid="schema-group" class="group">
          <summary class="group-summary">{{ group.label }}</summary>
          <ul class="tables">
            <li
              v-for="table in group.tables"
              :key="`${group.key}|${table.name}`"
              class="table-item"
            >
              <details data-testid="schema-table" class="table" @toggle="onToggleTable(table)">
                <summary class="table-summary">
                  <span class="table-name">{{ table.name }}</span>
                  <button
                    type="button"
                    data-testid="schema-browse-table"
                    class="insert-button"
                    :title="t('schema.browse-table', { n: BROWSE_ROWS })"
                    @click.stop.prevent="onBrowseTable(table)"
                  >
                    &#9654;
                  </button>
                  <button
                    type="button"
                    data-testid="schema-insert-table"
                    class="insert-button"
                    :title="t('schema.insert-table')"
                    @click.stop="onInsertTable(table)"
                  >
                    +
                  </button>
                </summary>

                <p
                  v-if="columnEntry(table)?.state === 'loading'"
                  data-testid="schema-columns-loading"
                  class="loading"
                >
                  {{ t("schema.columns.loading") }}
                </p>

                <!-- No sentence from underneath: the failure is the client's
                     own, so the prefix stands alone. -->
                <ErrorBanner
                  v-else-if="columnEntry(table)?.state === 'error'"
                  data-testid="schema-columns-error"
                  dense
                  :error="prefixed('schema.error.columns', null, t)"
                />

                <ul v-else-if="columnEntry(table)?.state === 'loaded'" class="columns">
                  <li
                    v-for="column in columnEntry(table)!.columns"
                    :key="column.name"
                    data-testid="schema-column"
                    class="column-item"
                  >
                    <span class="column-name">{{ column.name }}</span>
                    <span class="column-type">{{ column.declared_type }}</span>
                    <span
                      v-if="isPrimaryKey(column)"
                      data-testid="schema-column-pk"
                      class="badge badge-key"
                      :title="t('schema.column.primary-key')"
                    >
                      {{ t("schema.column.primary-key-abbr") }}
                    </span>
                    <span
                      v-if="isNotNull(column)"
                      data-testid="schema-column-not-null"
                      class="badge"
                    >
                      {{ t("schema.column.not-null") }}
                    </span>
                    <span
                      v-if="defaultOf(column) !== null"
                      data-testid="schema-column-default"
                      class="column-default"
                      :title="`${t('schema.column.default')} ${defaultOf(column)}`"
                    >
                      = {{ defaultOf(column) }}
                    </span>
                    <button
                      type="button"
                      data-testid="schema-insert-column"
                      class="insert-button"
                      :title="t('schema.insert-column')"
                      @click.stop="onInsertColumn(column)"
                    >
                      +
                    </button>
                  </li>
                </ul>
              </details>
            </li>
          </ul>
        </details>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.schema-browser {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.title {
  margin: 0;
  font-size: 1rem;
}

.refresh-button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 0.75rem;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  font-size: 0.85rem;
  cursor: pointer;
}

.refresh-button:disabled {
  opacity: 0.6;
  cursor: progress;
}

.empty {
  margin: 0;
  color: var(--text-muted);
  font-style: italic;
  font-size: 0.9rem;
}

.groups,
.tables,
.columns {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.tables {
  margin-left: 0.75rem;
}

.columns {
  margin-left: 1rem;
}

.group-summary,
.table-summary {
  cursor: pointer;
  font-size: 0.9rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.25rem 0;
}

.table-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85rem;
}

.column-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.15rem 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8rem;
}

.column-name {
  flex: 1 1 auto;
}

.column-type {
  color: var(--text-muted);
  font-size: 0.75rem;
}

.badge {
  flex: 0 0 auto;
  padding: 0 0.3rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-muted);
  font-size: 0.65rem;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.badge-key {
  border-color: var(--accent);
  color: var(--accent);
}

/* A default can be an arbitrary expression, so it is allowed to shrink
   away rather than push the insert button out of the row. The full text
   stays reachable through the title attribute. */
.column-default {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 0.7rem;
}

.insert-button {
  min-width: 28px;
  min-height: 28px;
  padding: 0 0.5rem;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: transparent;
  color: var(--accent);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.insert-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.loading {
  margin: 0.25rem 0;
  color: var(--text-muted);
  font-size: 0.8rem;
  font-style: italic;
}
</style>
