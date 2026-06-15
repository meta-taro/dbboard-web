<script setup lang="ts">
import { ref } from "vue";
import { useConnections, type Driver } from "../../composables/useConnections";

const { t } = useI18n();
const { list, lastError, register, remove } = useConnections();

const labelInput = ref("");
const driverInput = ref<Driver>("postgres");
const connectionStringInput = ref("");

async function onSubmit() {
  if (labelInput.value.trim() === "") return;
  await register({
    label: labelInput.value.trim(),
    driver: driverInput.value,
    connectionString:
      connectionStringInput.value.trim() === "" ? undefined : connectionStringInput.value.trim(),
  });
  // Reset only on success — keep the form populated so the user can fix
  // their input if the backend rejected it.
  if (lastError.value === null) {
    labelInput.value = "";
    connectionStringInput.value = "";
  }
}
</script>

<template>
  <section class="connections">
    <h2>{{ t("connections.title") }}</h2>

    <p v-if="lastError" data-testid="error-banner" role="alert" class="error-banner">
      {{ t(lastError.i18nKey) }}: {{ lastError.message }}
    </p>

    <form data-testid="add-form" class="add-form" @submit.prevent="onSubmit">
      <h3>{{ t("connections.add.heading") }}</h3>
      <label>
        {{ t("connections.add.label-input") }}
        <input v-model="labelInput" data-testid="label-input" type="text" autocomplete="off" />
      </label>
      <label>
        {{ t("connections.add.driver-input") }}
        <select v-model="driverInput" data-testid="driver-input">
          <option value="postgres">postgres</option>
          <option value="null">null</option>
        </select>
      </label>
      <label>
        {{ t("connections.add.connection-string-input") }}
        <input
          v-model="connectionStringInput"
          data-testid="connection-string-input"
          type="text"
          autocomplete="off"
        />
      </label>
      <button type="submit" data-testid="add-submit">
        {{ t("connections.add.submit") }}
      </button>
    </form>

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
            data-testid="delete-button"
            class="delete-button"
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

.error-banner {
  padding: 0.75rem 1rem;
  border-radius: 4px;
  background: rgba(220, 38, 38, 0.1);
  color: #991b1b;
  border: 1px solid rgba(220, 38, 38, 0.3);
}

.add-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.add-form h3 {
  margin: 0;
  font-size: 1rem;
}

.add-form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.9rem;
}

.add-form input,
.add-form select {
  /* Touch target >= 44 x 44 per Phase 1.5 DoD. */
  min-height: 44px;
  padding: 0 0.75rem;
  border-radius: 4px;
  border: 1px solid var(--border);
  font-size: 1rem;
  width: 100%;
  box-sizing: border-box;
}

.add-form button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 1rem;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #ffffff;
  font-size: 0.95rem;
  cursor: pointer;
}

.add-form button:focus-visible,
.add-form input:focus-visible,
.add-form select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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

.delete-button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 1rem;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  cursor: pointer;
  font-size: 0.9rem;
}

.delete-button:focus-visible {
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
