/**
 * Owns the `/connections` HTTP I/O for the Phase 4 connection list page.
 *
 * Mirrors the `useInstallPrompt` pattern: explicit Vue lifecycle imports
 * (mountable in a plain happy-dom Vitest environment without booting
 * `@nuxt/test-utils`), readonly wrappers on the public surface so callers
 * cannot mutate internal refs.
 *
 * The wire-format underscore -> hyphen i18n bridge lives in
 * `./internal/i18n-error.ts` so other composables (the SQL editor's
 * useQueryExecution being the first) share one source of truth.
 */
import { onMounted, readonly, ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { apiFetch } from "./internal/http";
import { parseError, type CategorisedError } from "./internal/i18n-error";

import type { SslMode } from "../utils/ssl-mode";

export type { CategorisedError, ErrorCategory } from "./internal/i18n-error";

/**
 * A driver name, which is a `string` and not a union of the two web knows
 * about today.
 *
 * The set lives in `StaticAdapterFactory` on the server and is read at
 * runtime through `useDrivers`. A union here would be a closed-world claim
 * the browser is in no position to make: the API can gain a driver without
 * the web being rebuilt, and the compiler would then reject a value the
 * server had just said was valid.
 */
export type Driver = string;

/**
 * Where a registered connection points, minus the credential.
 *
 * Mirrors `ConnectionParts` on the API (`apps/api/src/domain/connection-parts.ts`),
 * including the part that matters: there is no `password` member, and there is
 * no `connectionString` either. The server does not send one, and a type that
 * could hold one would invite a prefill that carries it.
 *
 * Every member is optional because what is known depends on how the connection
 * was registered — a pasted URL may name no user, and a `null`-driver
 * connection has no address at all, in which case `parts` is absent entirely.
 */
export interface ConnectionParts {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  sslMode?: SslMode;
}

/**
 * How a registered connection reaches its bastion, minus the key or the
 * password that opens it.
 *
 * Mirrors `SshParts` on the API (`apps/api/src/domain/ssh/ssh-parts.ts`) and
 * keeps its one deliberate omission: `auth` says *which* credential the
 * tunnel uses, never the credential. Desktop's `SshPrefill` can prefill a key
 * *path* because a path is not a secret; web takes key material, so the box
 * starts empty and `auth` is all there is to prefill.
 *
 * Nothing is optional. A tunnel the server refused to open is not described
 * at all — `ssh` is simply absent for a direct connection.
 */
export interface SshParts {
  host: string;
  port: number;
  user: string;
  auth: "private-key" | "password";
  hostKey:
    | { kind: "fingerprint"; fingerprint: string }
    | { kind: "known-hosts"; knownHosts: string };
}

/**
 * The `ssh` block of a connection body — what is *sent*, where `SshParts` is
 * what comes back (0031 slice F4).
 *
 * Two types rather than one because they are opposites in the only place it
 * matters: this one carries the credential and does not say which kind is in
 * use, and `SshParts` says which kind is in use and carries none. Mirrors
 * `SshTunnelDto`, including the omission it was written for — there is no
 * `privateKeyPath` member, because web takes key material and a path field
 * would have the API process reading files off the server on request.
 *
 * The pairing rules (exactly one of privateKey/password, exactly one of
 * fingerprint/knownHosts — ADR-0069) are not expressed as a union here. They
 * belong to `resolveSshTunnelConfig`, which applies them to every caller
 * rather than only the ones that came from this form, and a union would let
 * the browser refuse a combination the server had not been asked about.
 */
export interface SshInput {
  host: string;
  // Absent means 22, resolved server-side — the same default the tunnel
  // dials with, so the form never states one of its own.
  port?: number;
  user: string;
  /** PEM text, not a path. Blank on an edit means "keep the stored one". */
  privateKey?: string;
  passphrase?: string;
  password?: string;
  fingerprint?: string;
  knownHosts?: string;
}

export interface ConnectionView {
  id: string;
  label: string;
  driver: string;
  parts?: ConnectionParts;
  // Absent for a direct connection, which is a different statement from a
  // tunnel whose details are unknown — the server sends this whenever one is
  // configured (0031 slice F).
  ssh?: SshParts;
}

/**
 * What `POST /connections` accepts. Two mutually exclusive ways to name a
 * database, and the API prefers `connectionString` when both arrive — so
 * callers send one shape or the other, never a merge of the two.
 *
 * The parts are sent as parts rather than assembled into a DSN here. The
 * API's split-fields branch hands them to `pg.Pool` individually, so a
 * password containing `@`, `/`, `#` or `?` never passes through a URL
 * parser. Desktop composes a DSN in the frontend (ADR-0073) only because
 * sqlx offers no parts-shaped path; adopting that here would mean building
 * the bug in order to solve it.
 */
export interface RegisterInput {
  label: string;
  driver: Driver;
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  // Outranks any `sslmode` inside `connectionString`, which is what lets
  // the form's select be trusted in URL mode as well as parts mode.
  sslMode?: SslMode;
  // Nested rather than flattened into `sshHost`/`sshUser`, because the API
  // validates it with `@ValidateNested()` under a whitelist that strips what
  // it does not recognise: flattened fields would be dropped at the pipe and
  // the connection registered going direct.
  ssh?: SshInput;
}

/**
 * What `PATCH /connections/:id` accepts: the registration fields minus
 * `driver`, which is fixed once a connection exists.
 *
 * `password` is deliberately allowed to be the empty string. The API never
 * sends a password back, so the edit form's box starts blank, and submitting
 * that blank box has to mean "keep the credential you already have" rather
 * than "remove it" (ADR-0080). Removing one for good is a delete and a
 * re-add. `label` is optional here because an edit may re-point a connection
 * without renaming it.
 */
export interface UpdateInput {
  label?: string;
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  sslMode?: SslMode;
  /**
   * Three states, where registration has two (0031 slice F2, mirroring
   * desktop's `SshEditInput`):
   *
   * - **absent** — keep whatever tunnel the connection is already on;
   * - **`null`** — take it away, which absence cannot say and so needs a
   *   spelling of its own;
   * - **a block** — put it on this one, where a blank credential inside
   *   means carry the stored one (ADR-0080, extended to the bastion).
   */
  ssh?: SshInput | null;
}

/**
 * What `ConnectionForm` emits, in either mode.
 *
 * `RegisterInput` with the edit's nullable `ssh`, because one component
 * serves both modes and the page is what narrows the payload to the endpoint
 * it is about to call. Written as an `Omit` intersection rather than by
 * extending `RegisterInput`, since intersecting `SshInput | undefined` with
 * `SshInput | null | undefined` would quietly give back the former and lose
 * the removal this exists to carry.
 */
export type ConnectionFormPayload = Omit<RegisterInput, "ssh"> & { ssh?: SshInput | null };

export type ConnectionsState = "idle" | "loading" | "error";

export interface UseConnectionsOptions {
  apiBase?: string;
}

interface ListResponse {
  connections: ConnectionView[];
}

interface RegisterResponse {
  id: string;
}

function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  // Imported from `#imports` rather than relying on bare auto-import: the
  // explicit edge keeps Vite HMR happy when this file is hot-reloaded.
  // Unit tests always pass `apiBase` and never reach this branch.
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

export function useConnections(options?: UseConnectionsOptions) {
  const apiBase = resolveApiBase(options?.apiBase);
  const list = ref<ReadonlyArray<ConnectionView>>([]);
  const state = ref<ConnectionsState>("idle");
  const lastError = ref<CategorisedError | null>(null);

  async function refresh(): Promise<void> {
    state.value = "loading";
    try {
      const res = await apiFetch<ListResponse>(`${apiBase}/connections`);
      list.value = res.connections;
      state.value = "idle";
      lastError.value = null;
    } catch (err: unknown) {
      lastError.value = parseError(err);
      state.value = "error";
    }
  }

  async function register(input: RegisterInput): Promise<void> {
    state.value = "loading";
    try {
      await apiFetch<RegisterResponse>(`${apiBase}/connections`, {
        method: "POST",
        body: input,
      });
      await refresh();
    } catch (err: unknown) {
      lastError.value = parseError(err);
      state.value = "error";
    }
  }

  async function update(id: string, input: UpdateInput): Promise<void> {
    state.value = "loading";
    try {
      await apiFetch<ConnectionView>(`${apiBase}/connections/${id}`, {
        method: "PATCH",
        body: input,
      });
      // The response is the edited view, and it is thrown away on purpose:
      // `refresh` re-reads the whole list, which is what the page renders.
      // Patching one row in place from the response would leave the rest of
      // the list as stale as it was.
      await refresh();
    } catch (err: unknown) {
      lastError.value = parseError(err);
      state.value = "error";
    }
  }

  async function remove(id: string): Promise<void> {
    state.value = "loading";
    try {
      await apiFetch<null>(`${apiBase}/connections/${id}`, { method: "DELETE" });
      await refresh();
    } catch (err: unknown) {
      lastError.value = parseError(err);
      state.value = "error";
    }
  }

  onMounted(() => {
    void refresh();
  });

  return {
    list: readonly(list),
    state: readonly(state),
    lastError: readonly(lastError),
    refresh,
    register,
    update,
    remove,
  };
}
