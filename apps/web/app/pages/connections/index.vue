<script setup lang="ts">
import { computed, ref } from "vue";
import ConnectionForm from "../../components/ConnectionForm.vue";
import ErrorBanner from "../../components/ErrorBanner.vue";
import {
  useConnections,
  type ConnectionView,
  type RegisterInput,
} from "../../composables/useConnections";
import { useDrivers } from "../../composables/useDrivers";
import { fromCategorised } from "../../utils/display-error";

const { t } = useI18n();
const { list, lastError, register, update, remove } = useConnections();
const { drivers, lastError: driversError } = useDrivers();

// One banner, either source. A driver list that failed to load leaves the
// form unusable, so saying nothing about it would be showing a broken form
// with no explanation.
const banner = computed(() => lastError.value ?? driversError.value);

/**
 * The connection being edited, or `null` when the form is registering a new
 * one.
 *
 * One form at a time, in the same place on the page. Two sets of the same
 * boxes on one screen would be two places to type the answer, one of which is
 * wrong — and the shared component means the edit form is not a second form
 * to keep in step, it is the same one opened on an existing record.
 */
const editing = ref<ConnectionView | null>(null);

// The form owns what the user typed; the page owns whether the server took
// it. Resetting is therefore a call rather than a prop, made only once a
// registration has actually gone through.
const form = ref<InstanceType<typeof ConnectionForm> | null>(null);

function startEdit(row: ConnectionView): void {
  editing.value = row;
}

async function onSubmit(payload: RegisterInput): Promise<void> {
  const target = editing.value;
  if (target === null) {
    await register(payload);
    // Reset only on success — keep the form populated so the user can fix
    // their input if the backend rejected it.
    if (lastError.value === null) form.value?.reset();
    return;
  }

  // `driver` is dropped rather than sent: `PATCH /connections/:id` has no
  // such field, the DTO's whitelist would strip it, and sending one would be
  // claiming an edit can do something it cannot. The form carries it because
  // it is showing it.
  const { driver: _driver, ...edited } = payload;
  await update(target.id, edited);
  if (lastError.value === null) editing.value = null;
}
</script>

<template>
  <section class="connections">
    <h2>{{ t("connections.title") }}</h2>

    <ErrorBanner v-if="banner" data-testid="error-banner" :error="fromCategorised(banner, t)" />

    <!-- One component, two modes. The edit form is not a second form kept
         in step with this one; it is this one, opened on a record. -->
    <ConnectionForm
      ref="form"
      :key="editing?.id ?? 'add'"
      :mode="editing ? 'edit' : 'add'"
      :drivers="drivers"
      :initial="editing ?? undefined"
      @submit="onSubmit"
      @cancel="editing = null"
    />

    <ul v-if="list.length" class="connection-list">
      <li v-for="row in list" :key="row.id" data-testid="connection-row" class="row">
        <div class="row-meta">
          <strong>{{ row.label }}</strong>
          <span class="driver">{{ row.driver }}</span>
          <span class="row-id">
            {{ t("connections.row.id-label") }}: <code>{{ row.id }}</code>
          </span>
        </div>
        <div class="row-actions">
          <NuxtLink
            :to="`/connections/${row.id}/sql`"
            data-testid="run-sql-link"
            class="run-sql-link"
          >
            {{ t("sql.link-from-row") }}
          </NuxtLink>
          <button
            type="button"
            data-testid="edit-button"
            class="row-button"
            @click="startEdit(row)"
          >
            {{ t("connections.row.edit") }}
          </button>
          <button
            type="button"
            data-testid="delete-button"
            class="row-button"
            @click="remove(row.id)"
          >
            {{ t("connections.row.delete") }}
          </button>
        </div>
      </li>
    </ul>
    <p v-else class="empty">{{ t("connections.empty") }}</p>
  </section>
</template>

<style scoped>
.connections {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.connection-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.row-meta {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.row-meta .driver {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.row-meta .row-id {
  font-size: 0.85rem;
  color: var(--text-muted);
}

.row-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-self: stretch;
}

.run-sql-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  min-width: 44px;
  padding: 0 1rem;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: transparent;
  color: var(--accent);
  font-size: 0.9rem;
  text-decoration: none;
}

.run-sql-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.row-button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 1rem;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  cursor: pointer;
  font-size: 0.9rem;
}

.row-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.empty {
  color: var(--text-muted);
  font-style: italic;
}

@media (min-width: 768px) {
  .row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }

  .row-actions {
    flex-direction: row;
    align-self: center;
  }
}
</style>
