<script setup lang="ts">
import { computed, ref, watch } from "vue";
import ErrorBanner from "../../components/ErrorBanner.vue";
import { useConnections, type Driver, type RegisterInput } from "../../composables/useConnections";
import { defaultPortFor } from "../../utils/default-port";
import { fromCategorised } from "../../utils/display-error";
import { readSslModeFromUrl, SSL_MODES, type SslMode } from "../../utils/ssl-mode";

const { t } = useI18n();
const { list, lastError, register, remove } = useConnections();

const labelInput = ref("");
const driverInput = ref<Driver>("postgres");

// Field entry is the default and the URL is the way out of it (ADR-0073
// decision 2). Providers hand out ready-made URLs, so pasting one has to
// keep working; typing five fields is the case that happens more often.
const useUrl = ref(false);

const connectionStringInput = ref("");

// HeidiSQL's order, which desktop adopted so that anyone arriving from it
// finds the fields where they expect them.
const hostInput = ref("");
// `string | number` because `v-model` on `<input type="number">` hands back
// a number once the box parses, and the empty string while it does not.
const portInput = ref<string | number>("");
const userInput = ref("");
const passwordInput = ref("");
const databaseInput = ref("");

// Required by default, and the default is not a guess the API might
// override — the same value is sent explicitly, so the select always
// reports the connection that is about to be made (ADR-0079).
const sslModeInput = ref<SslMode>("require");

// Editing the URL moves the select to whatever that URL will actually get.
// Only a URL that states a mode moves it: one that says nothing is not a
// reason to discard a choice the user made here.
watch(connectionStringInput, (text) => {
  const stated = readSslModeFromUrl(text);
  if (stated !== undefined) sslModeInput.value = stated;
});

// The null adapter connects to nothing and ignores every credential field.
// Rendering them would be offering inputs whose effect is nil — the defect
// ADR-0074 names, one level below the driver list.
const needsCredential = computed(() => driverInput.value !== "null");

// A blank box means "not supplied", which is not the same as an empty
// value: the API treats a supplied-but-empty user or database as a real
// one and forwards it, where it means something different from letting the
// server apply its own default.
function supplied(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Blank falls back to the driver's default (ADR-0073 decision 3).
// Unparseable does too rather than sending NaN — `type="number"` already
// makes that hard to reach, but a fallback the user can see beats a
// payload the server cannot read.
function resolvePort(driver: Driver): number | undefined {
  const parsed = Number.parseInt(String(portInput.value).trim(), 10);
  return Number.isNaN(parsed) ? defaultPortFor(driver) : parsed;
}

// One entry mode or the other, never a merge. The API prefers
// `connectionString` when both arrive, so sending an abandoned host
// alongside a URL would have it silently ignored — the form would be
// showing one thing and sending another.
function buildPayload(): RegisterInput {
  const base = { label: labelInput.value.trim(), driver: driverInput.value };
  if (!needsCredential.value) return base;
  // The TLS choice belongs to both modes, so it is added to both rather
  // than living inside either branch.
  const secured = { ...base, sslMode: sslModeInput.value };
  if (useUrl.value) {
    return { ...secured, connectionString: supplied(connectionStringInput.value) };
  }
  return {
    ...secured,
    host: supplied(hostInput.value),
    port: resolvePort(driverInput.value),
    user: supplied(userInput.value),
    password: supplied(passwordInput.value),
    database: supplied(databaseInput.value),
  };
}

async function onSubmit() {
  if (labelInput.value.trim() === "") return;
  const payload = buildPayload();
  // `undefined` members would still serialise as absent, but stripping
  // them here keeps the payload the tests assert on and the payload the
  // server receives literally the same object.
  await register(
    Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined),
    ) as unknown as RegisterInput,
  );
  // Reset only on success — keep the form populated so the user can fix
  // their input if the backend rejected it.
  if (lastError.value === null) {
    labelInput.value = "";
    connectionStringInput.value = "";
    hostInput.value = "";
    portInput.value = "";
    userInput.value = "";
    passwordInput.value = "";
    databaseInput.value = "";
    // Back to the safe default, so the next connection does not inherit an
    // opt-out from the last one.
    sslModeInput.value = "require";
  }
}
</script>

<template>
  <section class="connections">
    <h2>{{ t("connections.title") }}</h2>

    <ErrorBanner
      v-if="lastError"
      data-testid="error-banner"
      :error="fromCategorised(lastError, t)"
    />

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
      <template v-if="needsCredential">
        <label class="toggle">
          <input v-model="useUrl" data-testid="use-url-toggle" type="checkbox" />
          {{ t("connections.add.use-url") }}
        </label>

        <label v-if="useUrl">
          {{ t("connections.add.connection-string-input") }}
          <input
            v-model="connectionStringInput"
            data-testid="connection-string-input"
            type="text"
            autocomplete="off"
          />
        </label>

        <fieldset v-else class="parts">
          <legend>{{ t("connections.add.parts-heading") }}</legend>
          <label>
            {{ t("connections.add.host-input") }}
            <input v-model="hostInput" data-testid="host-input" type="text" autocomplete="off" />
          </label>
          <label>
            {{ t("connections.add.port-input") }}
            <!-- Blank is legitimate: `resolvePort` fills the driver default. -->
            <input
              v-model="portInput"
              data-testid="port-input"
              type="number"
              inputmode="numeric"
              min="1"
              max="65535"
              :placeholder="String(defaultPortFor(driverInput) ?? '')"
              autocomplete="off"
            />
          </label>
          <label>
            {{ t("connections.add.user-input") }}
            <input v-model="userInput" data-testid="user-input" type="text" autocomplete="off" />
          </label>
          <label>
            {{ t("connections.add.password-input") }}
            <input
              v-model="passwordInput"
              data-testid="password-input"
              type="password"
              autocomplete="off"
            />
          </label>
          <label>
            {{ t("connections.add.database-input") }}
            <input
              v-model="databaseInput"
              data-testid="database-input"
              type="text"
              autocomplete="off"
            />
          </label>
        </fieldset>

        <!-- Outside the entry-mode branch: "is this encrypted" is the same
             question whichever way the database was named. -->
        <label>
          {{ t("connections.add.ssl-input") }}
          <select v-model="sslModeInput" data-testid="ssl-mode-input">
            <option v-for="mode in SSL_MODES" :key="mode" :value="mode">
              {{ t(`connections.add.ssl-${mode}`) }}
            </option>
          </select>
        </label>
      </template>

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

/* The toggle reads as one control: the box and its wording sit on a line,
   and the whole line is the 44px target rather than the box alone. */
.add-form label.toggle {
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
}

.add-form label.toggle input[type="checkbox"] {
  min-height: 24px;
  width: 24px;
  flex: none;
}

.parts {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 0;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.parts legend {
  padding: 0 0.35rem;
  font-size: 0.85rem;
  color: var(--text-muted);
}

.add-form button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 1rem;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
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
