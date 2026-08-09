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
import ErrorBanner from "./ErrorBanner.vue";
import { useSshHostKey } from "../composables/useSshHostKey";
import { defaultPortFor, supportsSshTunnel } from "../utils/default-port";
import { fromCategorised } from "../utils/display-error";
import { readSslModeFromUrl, SSL_MODES, type SslMode } from "../utils/ssl-mode";

import type {
  ConnectionFormPayload,
  ConnectionView,
  Driver,
  SshInput,
} from "../composables/useConnections";

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
  submit: [payload: ConnectionFormPayload];
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

// ── The bastion in front of the database (0031 slice F5) ──────────────────
//
// Whether this driver can be behind one is read from the port table rather
// than listed here, because `StaticAdapterFactory` decides it the same way: a
// forward redirects a `host:port` pair, so a driver that cannot name a port
// has nothing to redirect. Turso and D1 therefore see no section at all, and
// so does a driver this build has never heard of — the API would answer a
// block on any of them with a 404, and a form that collected a bastion and a
// private key first would have collected them for nothing.
const offersTunnel = computed(() => supportsSshTunnel(driverInput.value));

// On rather than off when the server said the connection is already behind
// one. `ssh` is absent for a direct connection, which is a different
// statement from a tunnel whose details are unknown.
const sshEnabled = ref(props.initial?.ssh !== undefined);

const sshHostInput = ref(props.initial?.ssh?.host ?? "");
const sshPortInput = ref<string | number>(props.initial?.ssh?.port ?? "");
const sshUserInput = ref(props.initial?.ssh?.user ?? "");

// Prefilled from `auth`, which names the *kind* of credential without
// carrying it — the one thing about a secret that is safe to send back, and
// the reason an edit opens on the right pair of boxes.
const sshAuthInput = ref<"private-key" | "password">(props.initial?.ssh?.auth ?? "private-key");
// Never prefilled, in either mode, for the same reason the database password
// is not: there is nothing to prefill them from.
const sshPrivateKeyInput = ref("");
const sshPassphraseInput = ref("");
const sshPasswordInput = ref("");

// The host key is not a secret. It is the thing being trusted, so it comes
// back from the server and is shown — an operator who cannot see what their
// tunnel is pinned to cannot tell that it changed.
const storedHostKey = props.initial?.ssh?.hostKey;
const sshHostKeyInput = ref<"fingerprint" | "known-hosts">(storedHostKey?.kind ?? "fingerprint");
const sshFingerprintInput = ref(
  storedHostKey?.kind === "fingerprint" ? storedHostKey.fingerprint : "",
);
const sshKnownHostsInput = ref(
  storedHostKey?.kind === "known-hosts" ? storedHostKey.knownHosts : "",
);

const { probe: probeHostKey, lastError: probeError, state: probeState } = useSshHostKey();

// The port as a number, or nothing when the box is blank. Nothing rather than
// 22: the tunnel and the probe both resolve that default server-side, and a
// second copy here could drift — at which point the key being compared would
// belong to a different listener than the one the forward dials.
function sshPort(): number | undefined {
  const parsed = Number.parseInt(String(sshPortInput.value).trim(), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Ask the bastion what host key it presents, and put it in the box.
 *
 * A button rather than a watcher (ADR-0076): this dials a machine the
 * operator named, and probing while the host box is still being typed in
 * would connect to whatever prefix happened to resolve.
 *
 * A refused probe leaves the box as it was. Overwriting a stored pin with
 * nothing would turn a network blip into an unverified bastion, which is the
 * state ADR-0069 exists to refuse.
 */
async function fetchHostKey(): Promise<void> {
  const fetched = await probeHostKey(sshHostInput.value, sshPort());
  if (fetched !== null) sshFingerprintInput.value = fetched;
}

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

/**
 * The tunnel block, with the boxes the user left blank left out.
 *
 * Absent is how a blank credential says "keep the stored one" — the server
 * reads an empty string the same way, but sending nothing is the honest
 * spelling of "the user said nothing about it", and it is what the database
 * password already does one section up.
 *
 * The ADR-0069 pairing rules are not enforced here. `resolveSshTunnelConfig`
 * applies them to every caller rather than only the ones that came from this
 * form, and a second copy would eventually refuse a combination the server
 * had not been asked about.
 */
function buildSsh(): SshInput {
  const block: SshInput = {
    host: sshHostInput.value.trim(),
    user: sshUserInput.value.trim(),
  };
  const port = sshPort();
  if (port !== undefined) block.port = port;

  // Only the boxes on screen contribute. The pair that is hidden must not
  // send a leftover value: two credentials are refused as ambiguous, and the
  // one the user can no longer see is the one they did not mean.
  if (sshAuthInput.value === "private-key") {
    const key = supplied(sshPrivateKeyInput.value);
    if (key !== undefined) block.privateKey = key;
    const passphrase = supplied(sshPassphraseInput.value);
    if (passphrase !== undefined) block.passphrase = passphrase;
  } else {
    const password = supplied(sshPasswordInput.value);
    if (password !== undefined) block.password = password;
  }

  if (sshHostKeyInput.value === "fingerprint") {
    const fingerprint = supplied(sshFingerprintInput.value);
    if (fingerprint !== undefined) block.fingerprint = fingerprint;
  } else {
    const knownHosts = supplied(sshKnownHostsInput.value);
    if (knownHosts !== undefined) block.knownHosts = knownHosts;
  }

  return block;
}

/**
 * The `ssh` member of the payload, in whichever of its three states applies.
 *
 * Absent is the answer whenever this build has no boxes for the driver, even
 * on a connection the server said is behind a bastion. Hiding the section
 * must not read as switching the tunnel off: absent keeps it, so a build that
 * cannot render a tunnel can still rename the connection carrying it.
 */
function sshMember(): { ssh?: SshInput | null } {
  if (!offersTunnel.value) return {};
  if (sshEnabled.value) return { ssh: buildSsh() };
  // `null` only when there is something to remove. On a registration there is
  // nothing, and saying so would be an instruction with no subject.
  return props.initial?.ssh === undefined ? {} : { ssh: null };
}

// One entry mode or the other, never a merge. The API prefers
// `connectionString` when both arrive, so sending an abandoned host
// alongside a URL would have it silently ignored — the form would be
// showing one thing and sending another.
function buildPayload(): ConnectionFormPayload {
  const base = { label: labelInput.value.trim(), driver: driverInput.value };
  if (!needsCredential.value) return base;
  // The TLS choice belongs to both modes, so it is added to both rather
  // than living inside either branch. The tunnel is a peer of it: which
  // machine the traffic goes through is not part of naming the database.
  const secured = { ...base, sslMode: sslModeInput.value, ...sshMember() };
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
  // server receives literally the same object. `null` survives the filter,
  // which is the point of it being spelled `null`.
  emit(
    "submit",
    Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined),
    ) as unknown as ConnectionFormPayload,
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
  // Same argument for the bastion, one level stronger: the next connection
  // inheriting a filled-in tunnel would be a connection routed somewhere the
  // operator did not ask for.
  sshEnabled.value = false;
  sshHostInput.value = "";
  sshPortInput.value = "";
  sshUserInput.value = "";
  sshAuthInput.value = "private-key";
  sshPrivateKeyInput.value = "";
  sshPassphraseInput.value = "";
  sshPasswordInput.value = "";
  sshHostKeyInput.value = "fingerprint";
  sshFingerprintInput.value = "";
  sshKnownHostsInput.value = "";
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

      <!-- Absent entirely for a driver no forward can front, rather than
           disabled: there is no state of this form in which those boxes
           become useful, and the API would answer them with a 404. -->
      <template v-if="offersTunnel">
        <label class="toggle">
          <input v-model="sshEnabled" data-testid="ssh-toggle" type="checkbox" />
          {{ t("connections.form.ssh-toggle") }}
        </label>

        <fieldset v-if="sshEnabled" class="parts">
          <legend>{{ t("connections.form.ssh-heading") }}</legend>
          <label>
            {{ t("connections.form.ssh-host-input") }}
            <input
              v-model="sshHostInput"
              data-testid="ssh-host-input"
              type="text"
              autocomplete="off"
            />
          </label>
          <label>
            {{ t("connections.form.ssh-port-input") }}
            <!-- 22 is the placeholder and never the value: blank is sent as
                 blank, and the server resolves the same default the forward
                 dials with. -->
            <input
              v-model="sshPortInput"
              data-testid="ssh-port-input"
              type="number"
              inputmode="numeric"
              min="1"
              max="65535"
              placeholder="22"
              autocomplete="off"
            />
          </label>
          <label>
            {{ t("connections.form.ssh-user-input") }}
            <input
              v-model="sshUserInput"
              data-testid="ssh-user-input"
              type="text"
              autocomplete="off"
            />
          </label>

          <label>
            {{ t("connections.form.ssh-auth-input") }}
            <select v-model="sshAuthInput" data-testid="ssh-auth-input">
              <option value="private-key">{{ t("connections.form.ssh-auth-private-key") }}</option>
              <option value="password">{{ t("connections.form.ssh-auth-password") }}</option>
            </select>
          </label>

          <!-- One credential or the other is on screen, never both. Two
               arriving together is refused as ambiguous, and a hidden box
               still contributing one would make that unexplainable. -->
          <template v-if="sshAuthInput === 'private-key'">
            <label>
              {{ t("connections.form.ssh-private-key-input") }}
              <!-- Key text, not a path. A path field would have the API
                   process reading files off the server on request. -->
              <textarea
                v-model="sshPrivateKeyInput"
                data-testid="ssh-private-key-input"
                rows="4"
                spellcheck="false"
                autocomplete="off"
              ></textarea>
            </label>
            <label>
              {{ t("connections.form.ssh-passphrase-input") }}
              <input
                v-model="sshPassphraseInput"
                data-testid="ssh-passphrase-input"
                type="password"
                autocomplete="off"
              />
            </label>
          </template>
          <label v-else>
            {{ t("connections.form.ssh-password-input") }}
            <input
              v-model="sshPasswordInput"
              data-testid="ssh-password-input"
              type="password"
              autocomplete="off"
            />
          </label>

          <!-- The same sentence the database password gets, for the same
               reason: nothing can be prefilled here, so blank has to be told
               what it will do. -->
          <small v-if="props.initial?.ssh" data-testid="ssh-secret-keep-hint" class="hint">
            {{ t("connections.edit.ssh-secret-hint") }}
          </small>

          <label>
            {{ t("connections.form.ssh-host-key-input") }}
            <select v-model="sshHostKeyInput" data-testid="ssh-host-key-input">
              <!-- No third option. Accepting an unverified key is what
                   ADR-0069 refuses to have, so it is not offered. -->
              <option value="fingerprint">
                {{ t("connections.form.ssh-host-key-fingerprint") }}
              </option>
              <option value="known-hosts">
                {{ t("connections.form.ssh-host-key-known-hosts") }}
              </option>
            </select>
          </label>

          <template v-if="sshHostKeyInput === 'fingerprint'">
            <label>
              {{ t("connections.form.ssh-fingerprint-input") }}
              <input
                v-model="sshFingerprintInput"
                data-testid="ssh-fingerprint-input"
                type="text"
                spellcheck="false"
                autocomplete="off"
              />
            </label>
            <button
              type="button"
              data-testid="ssh-fetch-host-key"
              class="secondary"
              :disabled="probeState === 'probing'"
              @click="fetchHostKey"
            >
              {{
                probeState === "probing"
                  ? t("connections.form.ssh-fetching-host-key")
                  : t("connections.form.ssh-fetch-host-key")
              }}
            </button>
            <!-- What the button fetched is what the server saw, which is not
                 the same as what the operator was promised. Saying so is the
                 whole reason showing it is safe. -->
            <small class="hint">{{ t("connections.form.ssh-fingerprint-hint") }}</small>
          </template>
          <!-- No Fetch button here: a probe returns one key, and this box
               takes a file's worth of entries. -->
          <label v-else>
            {{ t("connections.form.ssh-known-hosts-input") }}
            <textarea
              v-model="sshKnownHostsInput"
              data-testid="ssh-known-hosts-input"
              rows="3"
              spellcheck="false"
              autocomplete="off"
            ></textarea>
          </label>

          <ErrorBanner
            v-if="probeError"
            data-testid="ssh-probe-error"
            dense
            :error="fromCategorised(probeError, t)"
          />
        </fieldset>
      </template>
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
.connection-form select,
.connection-form textarea {
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

/* Key material and a known_hosts file are both multi-line and both wrap
   badly; monospace keeps a mistyped character findable. */
.connection-form textarea {
  padding: 0.5rem 0.75rem;
  font-family: monospace;
  font-size: 0.85rem;
  resize: vertical;
}

.connection-form button:focus-visible,
.connection-form input:focus-visible,
.connection-form select:focus-visible,
.connection-form textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
