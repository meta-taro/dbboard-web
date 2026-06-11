/**
 * Owns the `/connections` HTTP I/O for the Phase 4 connection list page.
 *
 * Mirrors the `useInstallPrompt` pattern: explicit Vue lifecycle imports
 * (mountable in a plain happy-dom Vitest environment without booting
 * `@nuxt/test-utils`), readonly wrappers on the public surface so callers
 * cannot mutate internal refs.
 *
 * The composable bridges the wire-format underscore (`type_conversion`
 * emitted by `ContractErrorFilter`) to the existing hyphen i18n key
 * namespace (`error.prefix.type-conversion`). All other categories pass
 * through verbatim.
 */
import { onMounted, readonly, ref } from "vue";
import { apiFetch } from "./internal/http";

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

export type ErrorCategory = "connection" | "query" | "schema" | "type_conversion" | "capability";

export interface CategorisedError {
  category: ErrorCategory;
  message: string;
  i18nKey: `error.prefix.${string}`;
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

interface BackendErrorShape {
  data?: { error?: { category?: string; message?: string } };
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

function toI18nKey(category: ErrorCategory): `error.prefix.${string}` {
  // en.json uses `type-conversion` (hyphen); the backend emits
  // `type_conversion` (underscore). The other four categories share spelling.
  const suffix = category === "type_conversion" ? "type-conversion" : category;
  return `error.prefix.${suffix}`;
}

function parseError(err: unknown): CategorisedError {
  const envelope = (err as BackendErrorShape | null | undefined)?.data?.error;
  if (envelope && typeof envelope.category === "string" && typeof envelope.message === "string") {
    const category = envelope.category as ErrorCategory;
    return { category, message: envelope.message, i18nKey: toI18nKey(category) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    category: "connection",
    message,
    i18nKey: "error.prefix.connection",
  };
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
