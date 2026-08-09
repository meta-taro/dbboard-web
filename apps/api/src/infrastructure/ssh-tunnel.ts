/**
 * Opening and probing the SSH local-forward tunnel — the web mirror of
 * desktop's `crates/dbboard-tunnel/src/tunnel.rs` (ADR-0069, ADR-0076),
 * read at `main` = b98f7a6.
 *
 * {@link openSshTunnel} connects to the bastion, verifies its host key
 * against the configured policy, authenticates, binds an ephemeral loopback
 * listener, and forwards every accepted socket over an SSH `direct-tcpip`
 * channel to the far-side database. The returned handle owns the listener
 * and tears it down on {@link SshTunnelHandle.close} — bind its lifetime to
 * whatever holds the database connection so the forward outlives every query
 * but not the adapter.
 *
 * Desktop drives russh; this drives `ssh2`. The mirror is of the behaviour,
 * not of the driver. Two places where the runtimes disagree are called out
 * below: `ssh2` hands the host verifier a raw key blob where russh hands a
 * parsed key, and `ssh2` ships no `known_hosts` reader where russh does —
 * both are answered in `../domain/ssh`.
 */
import { createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Client } from "ssh2";

import { ConnectionError } from "../domain/errors";
import {
  sha256Fingerprint,
  verifyHostKey,
  type ForwardTarget,
  type SshTunnelConfig,
} from "../domain/ssh";

const LOOPBACK = "127.0.0.1";

/**
 * How long the session may go quiet before the client pokes the bastion.
 *
 * ssh2, like russh, leaves keepalives off by default, which is what lets an
 * idle tunnel die unnoticed: a database session nobody queries sends nothing,
 * sshd (or a NAT/firewall in between) reaps the connection, and the loopback
 * forward stops working while the handle is still held. Thirty seconds is
 * comfortably under the shortest idle window commonly configured — OpenSSH's
 * own `ClientAliveInterval` guidance, NAT table entries (typically 300 s),
 * cloud load-balancer idle timeouts (60–350 s).
 */
export const KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * How many unanswered keepalives end the session.
 *
 * The other half of the point: a bastion that has silently gone away should
 * surface as a closed session — and therefore a failed connect on the next
 * attempt — rather than as a forward that accepts sockets and never answers.
 * Three misses is 90 s of confirmed silence.
 */
export const KEEPALIVE_COUNT_MAX = 3;

/**
 * How long a host-key probe may wait for the handshake.
 *
 * Desktop's probe inherits russh's default. Here the probe is reachable from
 * an HTTP route, so a black-holed host would otherwise hold a request open
 * for as long as the TCP stack allows.
 */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * The options this module hands the driver.
 *
 * A structural subset of ssh2's `ConnectConfig`, declared here so the import
 * of `ssh2` stays inside {@link createSsh2Client} and so {@link
 * sshConnectOptions} can be asserted without a bastion.
 */
export interface SshConnectOptions {
  host: string;
  port: number;
  username?: string;
  privateKey?: string;
  passphrase?: string;
  password?: string;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
  readyTimeout?: number;
  /**
   * With no `hostHash` set, ssh2 passes the server's key blob verbatim. That
   * is the shape `../domain/ssh` wants: russh hands its verifier a parsed
   * key, so the digest that russh computes for free is computed here instead.
   */
  hostVerifier: (key: Buffer) => boolean;
}

/** The seam between this module and `ssh2`'s `Client`. */
export interface SshClient {
  on(event: "ready", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  connect(options: SshConnectOptions): void;
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | undefined, stream: Duplex) => void,
  ): void;
  end(): void;
}

export interface SshTunnelDeps {
  createClient?: () => SshClient;
}

/** A running local forward. Closing it stops the listener and the session. */
export interface SshTunnelHandle {
  /** The loopback port to point the database client at. */
  readonly localPort: number;
  close(): Promise<void>;
}

/** The only function that touches `ssh2`. */
function createSsh2Client(): SshClient {
  return new Client();
}

/**
 * The driver options for one tunnel.
 *
 * Exactly one credential is ever set, because {@link SshTunnelConfig}'s auth
 * is a union — offering both would let ssh2 fall back from the one the
 * operator configured to the one they did not.
 */
export function sshConnectOptions(
  config: SshTunnelConfig,
  hostVerifier: (key: Buffer) => boolean = () => false,
): SshConnectOptions {
  const base: SshConnectOptions = {
    host: config.host,
    port: config.port,
    username: config.user,
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: KEEPALIVE_COUNT_MAX,
    hostVerifier,
  };

  if (config.auth.kind === "password") {
    return { ...base, password: config.auth.password };
  }
  return config.auth.passphrase === undefined
    ? { ...base, privateKey: config.auth.privateKey }
    : { ...base, privateKey: config.auth.privateKey, passphrase: config.auth.passphrase };
}

/**
 * Connect, verify, authenticate, and start forwarding a fresh loopback port
 * to `target` on the far side.
 *
 * @throws {ConnectionError} on host-key refusal, auth failure, or transport
 * failure. Host-key refusals carry the reason `../domain/ssh` produced, not
 * the driver's text: ssh2 reduces every refusal to "Handshake failed", and
 * "your pin no longer matches" and "this host is not pinned yet" ask the
 * operator for opposite responses.
 */
export async function openSshTunnel(
  config: SshTunnelConfig,
  target: ForwardTarget,
  deps: SshTunnelDeps = {},
): Promise<SshTunnelHandle> {
  const client = (deps.createClient ?? createSsh2Client)();

  // Captured by the verifier and preferred over whatever error ssh2 raises
  // afterwards, the same way desktop's `VerifyHandler` captures its rejection.
  let rejection: string | undefined;
  const hostVerifier = (key: Buffer): boolean => {
    const verdict = verifyHostKey(config.hostKey, config.host, config.port, key);
    if (!verdict.accepted) rejection = verdict.reason;
    return verdict.accepted;
  };

  await new Promise<void>((resolve, reject) => {
    client.on("ready", resolve);
    client.on("error", (error) => {
      reject(
        new ConnectionError(rejection ?? `ssh tunnel to ${endpoint(config)}: ${error.message}`),
      );
    });
    client.connect(sshConnectOptions(config, hostVerifier));
  }).catch((error: unknown) => {
    client.end();
    throw error;
  });

  const live = new Set<Socket>();
  const server = createServer((local) => {
    live.add(local);
    local.on("close", () => live.delete(local));
    // A socket the far side never answers is worse than a socket told the
    // connection failed, so an unopenable channel closes the local end.
    local.on("error", () => local.destroy());
    client.forwardOut(
      LOOPBACK,
      local.remotePort ?? 0,
      target.host,
      target.port,
      (error, stream) => {
        if (error !== undefined) {
          local.destroy();
          return;
        }
        stream.on("error", () => local.destroy());
        local.pipe(stream).pipe(local);
      },
    );
  });

  const localPort = await listen(server, config);

  let closed = false;
  return {
    localPort,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of live) socket.destroy();
      live.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      client.end();
    },
  };
}

/**
 * Read the bastion's host-key fingerprint without authenticating — the SSH
 * equivalent of a first-connection host-key prompt (ADR-0076).
 *
 * The verifier captures the key and then refuses it, so the session never
 * reaches auth. Mirrors desktop's `probe_host_key`, including the part that
 * looks odd: the connect is *expected* to fail, and only the captured value
 * matters.
 *
 * @throws {ConnectionError} if the host never presented a key. The caller
 * must not be handed an empty string to pin.
 */
export async function probeHostKey(
  host: string,
  port: number,
  deps: SshTunnelDeps = {},
): Promise<string> {
  const client = (deps.createClient ?? createSsh2Client)();
  let captured: string | undefined;

  await new Promise<void>((resolve) => {
    // Both paths resolve: a probe that reached a key has done its job even
    // though the handshake then failed, and one that did not is reported
    // below rather than as whatever transport error arrived.
    client.on("ready", resolve);
    client.on("error", () => resolve());
    client.connect({
      host,
      port,
      readyTimeout: PROBE_TIMEOUT_MS,
      hostVerifier: (key: Buffer): boolean => {
        captured = sha256Fingerprint(key);
        return false;
      },
    });
  });
  client.end();

  if (captured === undefined) {
    throw new ConnectionError(`ssh host ${host}:${port}: server key was not received`);
  }
  return captured;
}

function endpoint(config: SshTunnelConfig): string {
  return `${config.host}:${config.port}`;
}

async function listen(server: Server, config: SshTunnelConfig): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", (error: Error) => {
      reject(new ConnectionError(`ssh tunnel to ${endpoint(config)}: ${error.message}`));
    });
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new ConnectionError(`ssh tunnel to ${endpoint(config)}: local forward has no port`));
        return;
      }
      resolve(address.port);
    });
  });
}
