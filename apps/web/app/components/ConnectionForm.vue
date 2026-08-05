<script setup lang="ts">
/**
 * The connection form, in both of its two modes.
 *
 * One component rather than two because registering and editing ask the same
 * questions — where the database is, who connects to it, and how the traffic
 * is protected. Desktop reached the same shape from the other direction
 * (ADR-0080 decision 5: `formForEdit` fills the registration form rather than
 * opening a different one), and a second copy here would drift from this one
 * the first time a field is added.
 *
 * Two things differ, and only two:
 *
 * - **The driver is fixed once a connection exists.** Swapping it under a live
 *   id would keep the label while changing what the connection is, so edit
 *   mode shows it and does not offer to change it.
 * - **The password box starts blank and blank means keep.** The API never
 *   sends a credential back, so there is nothing to prefill; leaving the box
 *   alone keeps the stored one rather than removing it (ADR-0080). Removing
 *   one for good is a delete and a re-add.
 */
import { computed, ref, watch } from "vue";
import { defaultPortFor } from "../utils/default-port";
import { readSslModeFromUrl, SSL_MODES, type SslMode } from "../utils/ssl-mode";

import type { ConnectionView, Driver, RegisterInput } from "../composables/useConnections";

const props = withDefaults(
  defineProps<{
    mode: "add" | "edit";
    drivers: ReadonlyArray<Driver>;
    /** The record being edited. Required in edit mode, unread in add mode. */
    initial?: ConnectionView;
  }>(),
  { initial: undefined },
);

const emit = defineEmits<{
  /**
   * Always carries `driver`, in both modes. In edit mode it is the record's
   * own driver and the page drops it before the PATCH — the form reports what
   * it is showing, and what the wire accepts is the page's business.
   */
  submit: [payload: RegisterInput];
  cancel: [];
}>();

const { t } = useI18n();

const isEdit = computed(() => props.mode === "edit");

const labelInput = ref(props.initial?.label ?? "");

// In add mode there is no initial value: the options are server-owned
// (slice E), so the default is whichever driver the factory lists first and
// it is not known yet.
const driverInput = ref<Driver>(props.initial?.driver ?? "");

// Adopt a default when the list arrives, but only when the current value is
// not on it. A late-arriving list must not undo a choice the user has
// already made — the fetch can finish after the form is interactive. Edit
// mode sits this out: its driver came from the record, and the record is not
// a suggestion.
watch(
  () => props.drivers,
  (available) => {
    if (isEdit.value) return;
    if (available.length === 0) return;
    if (!available.includes(driverInput.value)) driverInput.value = available[0]!;
  },
  { immediate: true },
);

// Field entry is the default and the URL is the way out of it (ADR-0073
// decision 2). Providers hand out ready-made URLs, so pasting one has to
// keep working; typing five fields is the case that happens more often.
// An edit opens in parts mode for the same reason plus one more: parts are
// what the server sent back, and there is no stored URL to show.
const useUrl = ref(false);

const connectionStringInput = ref("");

// HeidiSQL's order, which desktop adopted so that anyone arriving from it
// finds the fields where they expect them.
const hostInput = ref(props.initial?.parts?.host ?? "");
// `string | number` because `v-model` on `<input type="number">` hands back
// a number once the box parses, and the empty string while it does not.
const portInput = ref<string | number>(props.initial?.parts?.port ?? "");
const userInput = ref(props.initial?.parts?.user ?? "");
// Never prefilled, in either mode. There is nothing to prefill it from.
const passwordInput = ref("");
const databaseInput = ref(props.initial?.parts?.database ?? "");

// Required by default, and the default is not a guess the API might
// override — the same value is sent explicitly, so the select always
// reports the connection that is about to be made (ADR-0079).
const sslModeInput = ref<SslMode>(props.initial?.parts?.sslMode ?? "require");

// Editing the URL moves the select to whatever that URL will actually get.
// Only a URL that states a mode moves it: one that says nothing is not a
// reason to discard a choice the user made here.
watch(connectionStringInput, (text) => {
  const stated = readSslModeFromUrl(text);
  if (stated !== undefined) sslModeInput.value = stated;
});

// The null adapter connects to nothing and ignores every credential field.
// Rendering them would be offering inputs whose effect is nil — the defect
// ADR-0074 names, one level below the driver list. The empty case is the
// same judgement: with no driver chosen there is nothing to hold a
// credential.
const needsCredential = computed(() => driverInput.value !== "" && driverInput.value !== "null");

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
    // Blank emits nothing at all. On a registration that is a connection
    // with no password; on an edit the server reads the silence as "keep
    // the one you have", which is the same silence the box was showing.
    password: supplied(passwordInput.value),
    database: supplied(databaseInput.value),
  };
}

function onSubmit() {
  if (labelInput.value.trim() === "") return;
  // No driver means the list never loaded. Submitting would post a driver
  // the factory cannot build and come back a 404 — refuse here instead,
  // where the form can stay filled in.
  if (driverInput.value === "") return;
  const payload = buildPayload();
  // `undefined` members would still serialise as absent, but stripping
  // them here keeps the payload the tests assert on and the payload the
  // server receives literally the same object.
  emit(
    "submit",
    Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined),
    ) as unknown as RegisterInput,
  );
}

/**
 * Clears everything the user typed, leaving the driver alone.
 *
 * Called by the page after a successful registration rather than done here,
 * because the form cannot see whether the server accepted it — and clearing
 * a form the backend rejected would delete the input at the moment it is
 * needed. The driver survives because registering several connections
 * against the same one is the common case.
 */
function reset(): void {
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

defineExpose({ reset });
</script>

<template>
  <form
    :data-testid="isEdit ? 'edit-form' : 'add-form'"
    class="connection-form"
    @submit.prevent="onSubmit"
  >
    <h3>{{ isEdit ? t("connections.edit.heading") : t("connections.add.heading") }}</h3>
    <label>
      {{ t("connections.form.label-input") }}
      <input v-model="labelInput" data-testid="label-input" type="text" autocomplete="off" />
    </label>

    <!-- Shown, not offered. An edit that could change the driver would keep
         the label while changing what the connection is. -->
    <p v-if="isEdit" class="fixed-field">
      {{ t("connections.form.driver-input") }}:
      <span data-testid="driver-fixed">{{ driverInput }}</span>
    </p>
    <label v-else>
      {{ t("connections.form.driver-input") }}
      <select v-model="driverInput" data-testid="driver-input">
        <!-- Named by the server, not here. Adding a driver to the API's
             factory adds it below with no edit to this file. -->
        <option v-for="driver in drivers" :key="driver" :value="driver">{{ driver }}</option>
      </select>
    </label>

    <template v-if="needsCredential">
      <label class="toggle">
        <input v-model="useUrl" data-testid="use-url-toggle" type="checkbox" />
        {{ t("connections.form.use-url") }}
      </label>

      <label v-if="useUrl">
        {{ t("connections.form.connection-string-input") }}
        <input
          v-model="connectionStringInput"
          data-testid="connection-string-input"
          type="text"
          autocomplete="off"
        />
      </label>

      <fieldset v-else class="parts">
        <legend>{{ t("connections.form.parts-heading") }}</legend>
        <label>
          {{ t("connections.form.host-input") }}
          <input v-model="hostInput" data-testid="host-input" type="text" autocomplete="off" />
        </label>
        <label>
          {{ t("connections.form.port-input") }}
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
          {{ t("connections.form.user-input") }}
          <input v-model="userInput" data-testid="user-input" type="text" autocomplete="off" />
        </label>
        <label>
          {{ t("connections.form.password-input") }}
          <input
            v-model="passwordInput"
            data-testid="password-input"
            type="password"
            autocomplete="off"
          />
          <!-- The one place the two modes read differently, so it is the one
               place that says so. -->
          <small v-if="isEdit" data-testid="password-keep-hint" class="hint">
            {{ t("connections.edit.password-hint") }}
          </small>
        </label>
        <label>
          {{ t("connections.form.database-input") }}
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
        {{ t("connections.form.ssl-input") }}
        <select v-model="sslModeInput" data-testid="ssl-mode-input">
          <option v-for="option in SSL_MODES" :key="option" :value="option">
            {{ t(`connections.form.ssl-${option}`) }}
          </option>
        </select>
      </label>
    </template>

    <div class="actions">
      <!-- Nothing to connect with is a state the button should report,
           rather than one the user discovers by pressing it. An edit already
           has its driver, so the empty list cannot stop it. -->
      <button
        type="submit"
        :data-testid="isEdit ? 'edit-submit' : 'add-submit'"
        :disabled="!isEdit && drivers.length === 0"
      >
        {{ isEdit ? t("connections.edit.submit") : t("connections.add.submit") }}
      </button>
      <button
        v-if="isEdit"
        type="button"
        data-testid="edit-cancel"
        class="secondary"
        @click="emit('cancel')"
      >
        {{ t("connections.edit.cancel") }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.connection-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.connection-form h3 {
  margin: 0;
  font-size: 1rem;
}

.connection-form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.9rem;
}

.connection-form input,
.connection-form select {
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
.connection-form label.toggle {
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
}

.connection-form label.toggle input[type="checkbox"] {
  min-height: 24px;
  width: 24px;
  flex: none;
}

.fixed-field {
  margin: 0;
  font-size: 0.9rem;
  color: var(--text-muted);
}

.fixed-field span {
  color: var(--text);
  font-family: monospace;
}

.hint {
  color: var(--text-muted);
  font-size: 0.8rem;
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

.actions {
  display: flex;
  gap: 0.5rem;
}

.connection-form button {
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

.connection-form button.secondary {
  border-color: var(--border);
  background: transparent;
  color: inherit;
}

/* Reads as unavailable rather than merely unresponsive: the button is
   disabled only while the driver list is missing, which is a state the user
   has no other way to see. */
.connection-form button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.connection-form button:focus-visible,
.connection-form input:focus-visible,
.connection-form select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
