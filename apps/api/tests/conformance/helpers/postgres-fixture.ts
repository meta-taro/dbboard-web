import { GenericContainer, type StartedTestContainer } from "testcontainers";

// Single Postgres container shared between the desktop loopback server
// and the in-process web server. The conformance test pivots on
// identical upstream behavior — the same SQL must produce the same row
// counts, the same divide-by-zero, the same syntax errors — so both
// sides have to point at the same database.
//
// Startup time on a cold Docker daemon is dominated by image pull. We
// allow two minutes; CI keeps the image warm via layer caching so the
// real cost is closer to ten seconds.
const STARTUP_TIMEOUT_MS = 120_000;

export interface PostgresFixture {
  readonly container: StartedTestContainer;
  readonly connectionString: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export async function startSharedPostgres(): Promise<PostgresFixture> {
  const container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "test",
      POSTGRES_USER: "test",
    })
    .withExposedPorts(5432)
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  return {
    container,
    connectionString: `postgresql://test:test@${host}:${port}/test`,
    host,
    port,
    user: "test",
    password: "test",
    database: "test",
  };
}
