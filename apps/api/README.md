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

# Register the connection. `sslmode=disable` is needed because the
# container above has no TLS configured — see "TLS" below.
curl -s -X POST http://localhost:4000/connections \
  -H 'Content-Type: application/json' \
  -d '{"driver":"postgres","label":"dev","connectionString":"postgres://postgres:dev@localhost:5432/postgres?sslmode=disable"}'
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

### TLS

TLS is on unless you turn it off, on both paths. An unqualified URL, a URL
carrying `sslmode=prefer`, and a set of split fields all resolve to
`require`; only an explicit `sslmode=disable` connects in plaintext.

`prefer` is rewritten rather than honoured. libpq reads it as "try TLS,
fall back to plaintext"; node-pg has no such fallback and this API used to
resolve it to no-TLS outright, so a URL carrying it was asking for a
plaintext connection while looking like it asked for an encrypted one.

`require` encrypts without verifying the server certificate — the same
meaning libpq gives it. That defends against passive interception, not
against an active attacker presenting a certificate of their own.
Verification needs a CA the caller can nominate, which this API has
nowhere to accept yet.

A server with TLS unconfigured — a local container, a database reached
through an SSH tunnel — needs the opt-out written down. Either spelling
works:

```jsonc
// inside a connection string, where libpq's conventions apply
{
  "driver": "postgres",
  "label": "dev",
  "connectionString": "postgres://user:pass@localhost:5432/db?sslmode=disable",
}

// as a field, which is the only way to say it on the split-fields path
{
  "driver": "postgres",
  "label": "dev",
  "host": "localhost",
  "port": 5432,
  "database": "db",
  "user": "user",
  "password": "pass",
  "sslMode": "disable",
}
```

The field takes `require` or `disable` and nothing else — `prefer` and the
`verify-*` modes are a 422. That is stricter than the connection-string
path treats the same words, on purpose: text inside a pasted URL may not
be the user's own, so it is hardened silently, whereas the field is a claim
about which option the form's TLS select was on. There is no third option,
so a third value means the client has drifted from the API, and hardening
it would hide that. When both are present the field wins, because a select
that lost to a stale query parameter would be reporting a choice it does
not make.

Mirrors desktop ADR-0078. A connection the user believes is encrypted and
is not is worse than one they knowingly turned off.

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
