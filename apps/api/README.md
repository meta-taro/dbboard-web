# @dbboard-web/api

NestJS backend for **dbboard-web**. Mirrors the HTTP contract defined in
[`docs/api-contract.md`](../../docs/api-contract.md) and hosts the
`DatabaseAdapter` implementations (NullAdapter, PostgresAdapter, ...).

## Running locally

```sh
pnpm install                 # at the repo root
pnpm --filter @dbboard-web/api start   # http://localhost:4000
```

`POST /query` (legacy global adapter) and `POST /connections/:id/query`
(per-registered-connection) are the two query entry points. See
[`docs/api-contract.md`](../../docs/api-contract.md) for the wire format.

## Postgres adapter (ticket 0004)

The Postgres adapter speaks to any Postgres-wire database — local
`postgres:16-alpine`, Neon, Supabase. `sslmode` is auto-upgraded to
`require` for `*.neon.tech` and `*.supabase.co` hostnames.

### Quickstart against a local container

```sh
docker run --rm -d -e POSTGRES_PASSWORD=dev -p 5432:5432 --name dev-pg postgres:16-alpine
pnpm --filter @dbboard-web/api start &

# Register the connection.
curl -s -X POST http://localhost:4000/connections \
  -H 'Content-Type: application/json' \
  -d '{"driver":"postgres","label":"dev","connectionString":"postgres://postgres:dev@localhost:5432/postgres"}'
# → { "id": "<uuid>" }

# Run a query against it.
curl -s -X POST "http://localhost:4000/connections/<uuid>/query" \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT 1 AS one, true AS yes, NULL AS empty"}'

# Cleanup.
docker rm -f dev-pg
```

### Connection shape

`POST /connections` accepts either path:

```jsonc
// connectionString (libpq-style URI)
{ "driver": "postgres", "label": "dev", "connectionString": "postgres://user:pass@host:5432/db" }

// split fields
{
  "driver": "postgres",
  "label": "dev",
  "host": "localhost",
  "port": 5432,
  "database": "postgres",
  "user": "postgres",
  "password": "secret"
}
```

Secrets never reach `GET /connections`. Only `{ id, label, driver }` is
exposed in the listing — see the secret-leak guard in
[`test/http-contract.spec.ts`](./test/http-contract.spec.ts).

## Tests

```sh
pnpm --filter @dbboard-web/api test
```

The suite includes integration tests that spin up `postgres:16-alpine`
via [`testcontainers`](https://node.testcontainers.org/) (see
[`test/postgres-integration.spec.ts`](./test/postgres-integration.spec.ts)).
They auto-skip if the Docker daemon is unreachable, so the suite still
passes on hosts without Docker. To run them you need:

- Docker Desktop / Engine running, **or**
- `DOCKER_HOST` pointing at a reachable daemon

The first run pulls the `postgres:16-alpine` image (~80 MB); subsequent
runs reuse the local layer cache.
