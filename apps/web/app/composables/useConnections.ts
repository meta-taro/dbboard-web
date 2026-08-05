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

export interface ConnectionView {
  id: string;
  label: string;
  driver: string;
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
}

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
    remove,
  };
}
