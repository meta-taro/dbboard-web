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
// number with no destination. A driver this table has never heard of gets
// none either — since slice E the server can offer one — and the port box
// simply shows no placeholder rather than a number borrowed from elsewhere.
//
// MySQL's row arrived with its adapter in 0031 slice C, and is owed from
// then: `mysql2` applies 3306 itself when the payload omits a port, so
// nothing was ever sent wrong, but the box showed no placeholder and the
// form was therefore declining to say what it was about to connect to.
const DEFAULT_PORTS: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
};

export function defaultPortFor(driver: Driver): number | undefined {
  return DEFAULT_PORTS[driver];
}

/**
 * Whether this driver can be fronted by an SSH tunnel (0031 slice F4).
 *
 * Reads the table above rather than keeping a list beside it, which is how
 * `StaticAdapterFactory` reaches the same answer: a `defaultPort` on the
 * builder is exactly what makes a driver tunnel-capable there. The two can
 * only be wrong separately — a forward redirects a TCP `host:port` pair, so
 * a driver that cannot say which port it speaks on has nothing to redirect.
 * Turso is a libSQL URL, D1 an HTTPS API, and `null` connects to nothing.
 *
 * A driver this build has no row for is treated as unable, which is the
 * conservative direction: the cost is a tunnel-capable driver whose boxes
 * appear a release late, against a form that would otherwise collect a
 * bastion and a private key and post them at a 404.
 */
export function supportsSshTunnel(driver: Driver): boolean {
  return defaultPortFor(driver) !== undefined;
}
