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
import { apiFetch } from "./internal/http";
import { parseError, type CategorisedError } from "./internal/i18n-error";

export type { CategorisedError, ErrorCategory } from "./internal/i18n-error";

export type Driver = "postgres" | "null";

export interface ConnectionView {
  id: string;
  label: string;
  driver: string;
}

export interface RegisterInput {
  label: string;
  driver: Driver;
  connectionString?: string;
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
  // useRuntimeConfig is only present in a Nuxt app context. Tests pass
  // `apiBase` explicitly, so this branch is production-only.
  const cfg = (
    globalThis as unknown as {
      useRuntimeConfig?: () => { public: { apiBaseUrl: string } };
    }
  ).useRuntimeConfig;
  return cfg?.().public.apiBaseUrl ?? "";
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
