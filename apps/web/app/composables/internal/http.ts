/**
 * Thin re-export of Nuxt's auto-imported `$fetch` under a named symbol so
 * composable tests can `vi.mock(".../internal/http")` without booting
 * `@nuxt/test-utils`. Runtime: forwards 1:1 to `$fetch`. Tests: replaced
 * by a stub. See `apps/web/tests/useConnections.test.ts` for the precedent.
 */

// Nuxt's auto-imports declare `$fetch` ambient. When the file is collected
// by a plain happy-dom Vitest worker (no Nuxt runtime), the symbol is
// undefined at module load — but the test replaces this whole module via
// `vi.mock` before the production binding ever runs, so the indirection is
// safe.
declare const $fetch: <T>(url: string, opts?: Record<string, unknown>) => Promise<T>;

export function apiFetch<T>(url: string, opts?: Record<string, unknown>): Promise<T> {
  return $fetch<T>(url, opts);
}
