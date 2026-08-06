import { CapabilityError } from "../errors";

/**
 * Moving a driver config from "dial the database directly" to "dial the
 * local end of a forward".
 *
 * Mirrors desktop `forward_target` / `rewrite_to_loopback`
 * (`crates/dbboard-connect/src/ssh.rs`), widened by one case: desktop's
 * config is always a URL, while web's `AdapterConfig` also carries split
 * `host` / `port` fields for postgres. Both are rewritten when both are
 * present, so nothing is left naming the far side — a field the driver
 * still reads is a path around the tunnel.
 */

export const DEFAULT_POSTGRES_PORT = 5432;
export const DEFAULT_MYSQL_PORT = 3306;

const LOOPBACK = "127.0.0.1";

/** The parts of a driver config this module reads. */
export interface ForwardSource {
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
}

export interface ForwardTarget {
  readonly host: string;
  readonly port: number;
}

function parse(connectionString: string): URL {
  try {
    return new URL(connectionString);
  } catch {
    throw new CapabilityError("ssh tunnel cannot read the connection string's host");
  }
}

/** `new URL` keeps the brackets on an IPv6 literal; ssh2 wants it bare. */
function unwrapIpv6(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Where the forward's far end should point.
 *
 * The connection string wins over the split fields when both are present.
 * pg parses the URL and then lets explicit fields override it, so such a
 * config is already ambiguous; what matters is that this function and the
 * rewrite agree, and the rewrite covers both.
 */
export function forwardTarget(config: ForwardSource, defaultPort: number): ForwardTarget {
  const connectionString = config.connectionString?.trim() ?? "";
  if (connectionString !== "") {
    const url = parse(connectionString);
    const host = unwrapIpv6(url.hostname);
    if (host === "") {
      throw new CapabilityError("ssh tunnel cannot read the connection string's host");
    }
    return { host, port: url.port === "" ? defaultPort : Number(url.port) };
  }

  const host = config.host?.trim() ?? "";
  if (host === "") {
    throw new CapabilityError("ssh tunnel requires the connection to name a host to forward to");
  }
  return { host, port: config.port ?? defaultPort };
}

/** Rewrite one URL to the loopback forward, keeping everything else. */
function rewriteUrl(connectionString: string, localPort: number): string {
  const url = parse(connectionString);
  url.hostname = LOOPBACK;
  url.port = String(localPort);
  return url.toString();
}

/**
 * The same config, pointed at the local end of the forward. Returns a copy —
 * the caller's config is the one the adapter was built from, and rebuilding
 * has to be able to start from the original.
 */
export function redirectToLoopback<T extends ForwardSource>(config: T, localPort: number): T {
  // A mutable mirror of ForwardSource: the public shape is readonly, and the
  // patch is the only place that is allowed to differ from it.
  const patch: { connectionString?: string; host?: string; port?: number } = {};

  const connectionString = config.connectionString?.trim() ?? "";
  if (connectionString !== "") {
    patch.connectionString = rewriteUrl(connectionString, localPort);
  }
  if ((config.host?.trim() ?? "") !== "") {
    patch.host = LOOPBACK;
    patch.port = localPort;
  }

  return { ...config, ...patch };
}
