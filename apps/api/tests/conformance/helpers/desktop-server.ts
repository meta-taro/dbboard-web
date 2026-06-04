import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { createServer } from "node:net";
import type { PostgresFixture } from "./postgres-fixture";

// Spawns the desktop loopback binary pointed at the same Postgres the
// web server uses. The binary path comes from `DBBOARD_SERVER_BIN`
// (matches the desktop project's own test convention — see
// `dbboard/crates/dbboard-server/README.md`); when unset the conformance
// suite is expected to skip rather than fail.
//
// We pick a free port via `net.createServer().listen(0)` to avoid races
// with anything else on the box, then close it and pass the number to
// the child. The classic "listen → close → reuse" pattern leaves a
// short window where another process could grab the port; the desktop
// binary's own retry loop on EADDRINUSE handles the corner case in
// practice.
export interface DesktopServer {
  readonly origin: string;
  readonly registerPostgres: () => Promise<string>;
  readonly stop: () => Promise<void>;
}

export interface DesktopServerOptions {
  readonly binaryPath: string;
  readonly fixture: PostgresFixture;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("failed to resolve a free port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export async function startDesktopServer(opts: DesktopServerOptions): Promise<DesktopServer> {
  const port = await pickFreePort();
  // Desktop honours `PORT` for the HTTP listener and `RUST_LOG` for
  // verbosity. Inherit stdio so flakes leave a debuggable trace.
  // `stdio: ["ignore", "pipe", "pipe"]` yields a ChildProcessByStdio
  // (null stdin), which is a narrower type than ChildProcessWithoutNullStreams.
  // Let TypeScript infer it rather than annotating the wrong shape.
  const child = spawn(opts.binaryPath, [], {
    env: {
      ...process.env,
      PORT: String(port),
      RUST_LOG: process.env.RUST_LOG ?? "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const buffers: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => buffers.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => buffers.push(chunk.toString("utf8")));

  const origin = `http://127.0.0.1:${port}`;
  await waitForLiveness(origin, child, buffers);

  return {
    origin,
    registerPostgres: async (): Promise<string> => {
      const reg = await fetch(`${origin}/connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "conformance-pg",
          driver: "postgres",
          connectionString: opts.fixture.connectionString,
        }),
      });
      if (reg.status !== 201) {
        throw new Error(
          `failed to register connection on desktop server: ${reg.status} ${await reg.text()}`,
        );
      }
      const body = (await reg.json()) as { id: string };
      return body.id;
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        // Hard cap — SIGKILL after five seconds if the child won't go.
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 5_000).unref();
      });
    },
  };
}

interface SpawnedChild {
  readonly exitCode: number | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: () => void): unknown;
}

async function waitForLiveness(
  origin: string,
  child: SpawnedChild,
  buffers: string[],
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `desktop server exited before becoming ready (code ${child.exitCode}). Logs:\n${buffers.join("")}`,
      );
    }
    try {
      const res = await fetch(`${origin}/health`);
      if (res.ok) return;
    } catch {
      // Connection refused while the child is still binding — retry.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill("SIGKILL");
  throw new Error(`desktop server did not pass /health within 30s. Logs:\n${buffers.join("")}`);
}
