/**
 * The port a driver uses when the form's port box is left blank, so the
 * common case needs four fields rather than five (ADR-0073 decision 3).
 *
 * A pure lookup rather than a member of `useConnections`, for two reasons.
 * It is not HTTP I/O — it decides nothing about the request, only what the
 * form shows before one is made. And the composable reaches for `#imports`
 * at module scope, so anything living beside it can only be tested by
 * booting Nuxt or by mocking the module wholesale; a table of numbers
 * should not cost that.
 */
import type { Driver } from "../composables/useConnections";

// `null` gets none: it connects to nothing, so a port for it would be a
// number with no destination.
//
// Desktop's table has a MySQL row at 3306. Web has no MySQL adapter yet, so
// mirroring the row would be inventing a default for a driver that cannot
// be selected — it arrives with the adapter, in rung 7.
export function defaultPortFor(driver: Driver): number | undefined {
  return driver === "postgres" ? 5432 : undefined;
}
