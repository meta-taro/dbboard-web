<script setup lang="ts">
import { computed, reactive } from "vue";
import ErrorBanner from "./ErrorBanner.vue";
import {
  quoteIdent,
  useSchemaBrowser,
  type ColumnInfo,
  type TableInfo,
} from "../composables/useSchemaBrowser";
import { prefixed } from "../utils/display-error";

interface Props {
  connectionId: string;
  apiBase?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (event: "insert", text: string): void;
}>();

const { t } = useI18n();
const { tables, state, lastError, refresh, loadColumns } = useSchemaBrowser(props.connectionId, {
  apiBase: props.apiBase,
});

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

function tableInsertText(table: TableInfo): string {
  return table.schema === null
    ? quoteIdent(table.name)
    : `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
}

function onInsertTable(table: TableInfo) {
  emit("insert", tableInsertText(table));
}

function onInsertColumn(column: ColumnInfo) {
  emit("insert", quoteIdent(column.name));
}

function columnEntry(table: TableInfo): ColumnEntry | undefined {
  return columnCache[cacheKey(table.schema, table.name)];
}
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
