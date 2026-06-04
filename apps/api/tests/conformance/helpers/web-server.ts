import type { AddressInfo } from "node:net";
import { createApp } from "../../../src/main";
import type { PostgresFixture } from "./postgres-fixture";

// Boots the web NestJS surface in-process on a random port and
// registers the shared Postgres as a connection so the query battery
// can address it via `POST /connections/:id/query`.
//
// In-process (not `child_process.spawn`) so a hung test stack-traces
// cleanly through both servers; the desktop side has no equivalent
// because it is a Rust binary we cannot `import`.
export interface WebServer {
  readonly origin: string;
  readonly connectionId: string;
  readonly close: () => Promise<void>;
}

export async function startWebServer(fixture: PostgresFixture): Promise<WebServer> {
  const app = await createApp();
  // listen(0) → kernel picks a free port. We read it back via
  // server.address() so test code never hardcodes 4000 / clashes with
  // a dev server the maintainer might already have running.
  await app.listen(0);
  const server = app.getHttpServer() as { address: () => AddressInfo | string | null };
  const address = server.address();
  if (!address || typeof address === "string") {
    await app.close();
    throw new Error("web server failed to bind to a TCP port");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  // Register through the public surface so the conformance test
  // exercises the same registration path a real client would use.
  const reg = await fetch(`${origin}/connections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: "conformance-pg",
      driver: "postgres",
      connectionString: fixture.connectionString,
    }),
  });
  if (reg.status !== 201) {
    await app.close();
    throw new Error(
      `failed to register connection on web server: ${reg.status} ${await reg.text()}`,
    );
  }
  const body = (await reg.json()) as { id: string };

  return {
    origin,
    connectionId: body.id,
    close: async () => {
      await app.close();
    },
  };
}
