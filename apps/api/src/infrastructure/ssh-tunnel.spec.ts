import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { PassThrough, type Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { ConnectionError } from "../domain/errors";
import { resolveSshTunnelConfig, sha256Fingerprint } from "../domain/ssh";
import {
  KEEPALIVE_COUNT_MAX,
  KEEPALIVE_INTERVAL_MS,
  openSshTunnel,
  probeHostKey,
  sshConnectOptions,
  type SshClient,
  type SshConnectOptions,
} from "./ssh-tunnel";

const HOST_KEY = Buffer.from("a server's public key blob");
const HOST_FINGERPRINT = sha256Fingerprint(HOST_KEY);

// A key body of exactly `AAAA` — see scripts/pii-scan.allow. Real material
// never has a four-character body.
const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";

function keyConfig(overrides: Record<string, unknown> = {}) {
  return resolveSshTunnelConfig({
    host: "bastion.internal",
    port: 2222,
    user: "deploy",
    privateKey: PEM,
    fingerprint: HOST_FINGERPRINT,
    ...overrides,
  });
}

interface FakeOptions {
  hostKey?: Buffer;
  /** Emitted instead of `ready`, once host-key verification has passed. */
  failWith?: Error;
  /** Emitted before the handshake gets as far as a key — a refused TCP
   * connection, which is what a probe of a wrong host looks like. */
  refuseBeforeKey?: Error;
  /** What `forwardOut` hands back. */
  openForward?: () => Duplex;
  forwardError?: Error;
}

/** Stands in for ssh2's `Client`: everything past the socket, nothing else. */
class FakeSshClient implements SshClient {
  connectOptions: SshConnectOptions | undefined;
  ended = false;
  readonly forwards: Array<{ dstIP: string; dstPort: number }> = [];

  private readonly onReady: Array<() => void> = [];
  private readonly onError: Array<(error: Error) => void> = [];

  constructor(private readonly options: FakeOptions = {}) {}

  on(event: "ready", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: string, listener: (...args: never[]) => void): void {
    if (event === "ready") this.onReady.push(listener as () => void);
    if (event === "error") this.onError.push(listener as (error: Error) => void);
  }

  connect(options: SshConnectOptions): void {
    this.connectOptions = options;
    setImmediate(() => {
      if (this.options.refuseBeforeKey !== undefined) {
        this.fail(this.options.refuseBeforeKey);
        return;
      }
      const key = this.options.hostKey ?? HOST_KEY;
      if (!options.hostVerifier(key)) {
        // What ssh2 itself says: the bland text is exactly why the module has
        // to keep its own reason.
        this.fail(new Error("Handshake failed: host fingerprint verification failed"));
        return;
      }
      if (this.options.failWith !== undefined) {
        this.fail(this.options.failWith);
        return;
      }
      for (const listener of this.onReady) listener();
    });
  }

  forwardOut(
    _srcIP: string,
    _srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | undefined, stream: Duplex) => void,
  ): void {
    this.forwards.push({ dstIP, dstPort });
    if (this.options.forwardError !== undefined) {
      callback(this.options.forwardError, undefined as unknown as Duplex);
      return;
    }
    callback(undefined, (this.options.openForward ?? (() => passthroughPair()))());
  }

  end(): void {
    this.ended = true;
  }

  private fail(error: Error): void {
    for (const listener of this.onError) listener(error);
  }
}

function passthroughPair(): Duplex {
  return new PassThrough();
}

/** Servers and sockets each test opens, torn down whatever the outcome. */
const openServers: Server[] = [];
const openSockets: Socket[] = [];

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  for (const server of openServers.splice(0)) server.close();
});

/** A TCP server that echoes whatever it is sent — the far-side "database". */
async function startEchoServer(): Promise<number> {
  const server = createServer((socket) => {
    socket.pipe(socket);
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** Send one line through the tunnel's local end and read the answer. */
async function roundTrip(port: number, message: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => socket.write(message));
    openSockets.push(socket);
    socket.on("data", (chunk) => resolve(chunk.toString("utf8")));
    socket.on("error", reject);
  });
}

describe("sshConnectOptions", () => {
  it("keeps an idle session alive", () => {
    // ssh2, like russh, leaves keepalives off. An unqueried tunnel is then
    // reaped by sshd or a NAT while the handle still looks healthy.
    const options = sshConnectOptions(keyConfig());

    expect(options.keepaliveInterval).toBe(KEEPALIVE_INTERVAL_MS);
    expect(options.keepaliveCountMax).toBe(KEEPALIVE_COUNT_MAX);
  });

  it("pokes at least twice inside the shortest idle window worth surviving", () => {
    expect(KEEPALIVE_INTERVAL_MS * 2).toBeLessThanOrEqual(60_000);
    // 0 would mean "never give up", which keeps a session that can no longer
    // forward anything.
    expect(KEEPALIVE_COUNT_MAX).toBeGreaterThan(0);
  });

  it("carries the endpoint and the user", () => {
    const options = sshConnectOptions(keyConfig());

    expect(options.host).toBe("bastion.internal");
    expect(options.port).toBe(2222);
    expect(options.username).toBe("deploy");
  });

  it("passes private-key material through as material", () => {
    const options = sshConnectOptions(keyConfig({ privateKey: PEM, passphrase: "s3cret" }));

    expect(options.privateKey).toBe(PEM);
    expect(options.passphrase).toBe("s3cret");
    expect(options.password).toBeUndefined();
  });

  it("omits the passphrase when the key has none", () => {
    expect(sshConnectOptions(keyConfig()).passphrase).toBeUndefined();
  });

  it("passes a password without also offering a key", () => {
    const options = sshConnectOptions(keyConfig({ privateKey: undefined, password: "hunter2" }));

    expect(options.password).toBe("hunter2");
    expect(options.privateKey).toBeUndefined();
  });
});

describe("openSshTunnel", () => {
  it("listens on loopback and forwards to the far side", async () => {
    const echoPort = await startEchoServer();
    const client = new FakeSshClient({
      openForward: () => {
        const socket = netConnect(echoPort, "127.0.0.1");
        openSockets.push(socket);
        return socket;
      },
    });

    const tunnel = await openSshTunnel(
      keyConfig(),
      { host: "db.internal", port: 5432 },
      { createClient: () => client },
    );

    expect(tunnel.localPort).toBeGreaterThan(0);
    await expect(roundTrip(tunnel.localPort, "ping")).resolves.toBe("ping");
    expect(client.forwards).toEqual([{ dstIP: "db.internal", dstPort: 5432 }]);

    await tunnel.close();
  });

  it("stops listening and ends the session on close", async () => {
    const client = new FakeSshClient();
    const tunnel = await openSshTunnel(
      keyConfig(),
      { host: "db.internal", port: 5432 },
      { createClient: () => client },
    );
    const port = tunnel.localPort;

    await tunnel.close();

    expect(client.ended).toBe(true);
    await expect(roundTrip(port, "ping")).rejects.toThrow();
  });

  it("is safe to close twice", async () => {
    const client = new FakeSshClient();
    const tunnel = await openSshTunnel(
      keyConfig(),
      { host: "db.internal", port: 5432 },
      { createClient: () => client },
    );

    await tunnel.close();
    await expect(tunnel.close()).resolves.toBeUndefined();
  });

  it("accepts a bastion whose key matches the pin", async () => {
    const client = new FakeSshClient();
    await expect(
      openSshTunnel(
        keyConfig(),
        { host: "db.internal", port: 5432 },
        { createClient: () => client },
      ),
    ).resolves.toBeDefined();
  });

  it("refuses a bastion whose key does not match the pin", async () => {
    const client = new FakeSshClient({ hostKey: Buffer.from("a different key") });

    await expect(
      openSshTunnel(
        keyConfig(),
        { host: "db.internal", port: 5432 },
        { createClient: () => client },
      ),
    ).rejects.toThrow(/fingerprint mismatch/);
  });

  it("reports the host-key reason rather than the driver's handshake text", async () => {
    const client = new FakeSshClient({ hostKey: Buffer.from("a different key") });

    // ssh2 says "Handshake failed". That is true and useless: the operator
    // needs to know their pin no longer matches.
    await expect(
      openSshTunnel(
        keyConfig(),
        { host: "db.internal", port: 5432 },
        { createClient: () => client },
      ),
    ).rejects.not.toThrow(/Handshake failed/);
  });

  it("tells an unknown host apart from a changed one", async () => {
    const unknown = new FakeSshClient({ hostKey: Buffer.from("some key") });
    const changed = new FakeSshClient({ hostKey: Buffer.from("some key") });
    const knownHosts = (key: Buffer): string =>
      `[bastion.internal]:2222 ssh-ed25519 ${key.toString("base64")}`;

    await expect(
      openSshTunnel(
        keyConfig({ fingerprint: undefined, knownHosts: "# empty\n" }),
        { host: "db.internal", port: 5432 },
        { createClient: () => unknown },
      ),
    ).rejects.toThrow(/unknown host/);

    await expect(
      openSshTunnel(
        keyConfig({ fingerprint: undefined, knownHosts: knownHosts(Buffer.from("another key")) }),
        { host: "db.internal", port: 5432 },
        { createClient: () => changed },
      ),
    ).rejects.toThrow(/KEY MISMATCH/);
  });

  it("reports a failed handshake as a connection error", async () => {
    const client = new FakeSshClient({
      failWith: new Error("All configured authentication methods failed"),
    });

    await expect(
      openSshTunnel(
        keyConfig(),
        { host: "db.internal", port: 5432 },
        { createClient: () => client },
      ),
    ).rejects.toBeInstanceOf(ConnectionError);
  });

  it("never quotes the credential back in a failure", async () => {
    const client = new FakeSshClient({ failWith: new Error("auth failed") });

    await expect(
      openSshTunnel(
        keyConfig({ privateKey: undefined, password: "hunter2" }),
        { host: "db.internal", port: 5432 },
        { createClient: () => client },
      ),
    ).rejects.toThrow(/^(?!.*hunter2).*$/s);
  });

  it("drops a local socket whose forward could not be opened", async () => {
    const client = new FakeSshClient({ forwardError: new Error("channel open failure") });
    const tunnel = await openSshTunnel(
      keyConfig(),
      { host: "db.internal", port: 5432 },
      { createClient: () => client },
    );

    // The far side is unreachable, so the local end has to close rather than
    // hang: a driver waiting on a socket that will never answer is worse than
    // a driver told the connection failed.
    const closed = new Promise<void>((resolve) => {
      const socket = netConnect(tunnel.localPort, "127.0.0.1");
      openSockets.push(socket);
      socket.on("error", () => resolve());
      socket.on("close", () => resolve());
    });
    await expect(closed).resolves.toBeUndefined();

    await tunnel.close();
  });
});

describe("probeHostKey", () => {
  it("returns the fingerprint the bastion presented", async () => {
    const client = new FakeSshClient();

    await expect(
      probeHostKey("bastion.internal", 2222, { createClient: () => client }),
    ).resolves.toBe(HOST_FINGERPRINT);
  });

  it("never authenticates — there is nothing to authenticate with yet", async () => {
    const client = new FakeSshClient();
    await probeHostKey("bastion.internal", 2222, { createClient: () => client });

    expect(client.connectOptions?.username).toBeUndefined();
    expect(client.connectOptions?.password).toBeUndefined();
    expect(client.connectOptions?.privateKey).toBeUndefined();
  });

  it("ends the session it opened", async () => {
    const client = new FakeSshClient();
    await probeHostKey("bastion.internal", 2222, { createClient: () => client });

    expect(client.ended).toBe(true);
  });

  it("fails when no key was ever presented", async () => {
    // A host that refuses the TCP connection never gets as far as a key, and
    // the caller must not be handed an empty string to pin.
    const client = new FakeSshClient({ refuseBeforeKey: new Error("ECONNREFUSED") });

    await expect(
      probeHostKey("bastion.internal", 2222, { createClient: () => client }),
    ).rejects.toBeInstanceOf(ConnectionError);
  });
});
