/**
 * The drivers this API build can connect with, read once per mount.
 *
 * Separate from `useConnections` because it is a different kind of fact. The
 * connection list changes whenever the user registers or deletes one, so it
 * is re-fetched on every mutation; the driver list is fixed at compile time
 * on the server and cannot change while the page is open. Folding it into
 * `refresh()` would re-ask a settled question on every round trip.
 *
 * Its reason for existing at all (0027 slice E) is that the form used to name
 * its `<option>`s in the template while `StaticAdapterFactory` owned the real
 * list. They agreed by coincidence. A driver added to the factory was
 * unreachable from the UI, and one offered by the UI that the factory lacked
 * produced a 404 on submit — the rule was right and the presentation was not.
 */
import { onMounted, readonly, ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { apiFetch } from "./internal/http";
import { parseError, type CategorisedError } from "./internal/i18n-error";

export interface UseDriversOptions {
  apiBase?: string;
}

interface DriversResponse {
  drivers: string[];
}

function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

export function useDrivers(options?: UseDriversOptions) {
  const apiBase = resolveApiBase(options?.apiBase);
  const drivers = ref<readonly string[]>([]);
  const lastError = ref<CategorisedError | null>(null);

  async function load(): Promise<void> {
    try {
      const res = await apiFetch<DriversResponse>(`${apiBase}/connections/drivers`);
      drivers.value = res.drivers;
      lastError.value = null;
    } catch (err: unknown) {
      // Stays empty rather than falling back to a guess. An option the caller
      // invented is exactly the thing this composable exists to stop showing.
      lastError.value = parseError(err);
    }
  }

  onMounted(() => {
    void load();
  });

  return {
    drivers: readonly(drivers),
    lastError: readonly(lastError),
    reload: load,
  };
}
