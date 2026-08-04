# 0024 — Adapter correctness: pin the text-protocol invariant, add a server-side statement timeout

**Status:** done (2026-08-04) · **Opened:** 2026-08-04 · **Rung 2** of
[`../parity-ledger.md`](../parity-ledger.md)

> Numbering collision worth naming once: this is **web ticket 0024**, and it
> partly concerns **desktop ADR-0024**. They are unrelated documents that
> happen to share a number. Desktop ADR-0024 turns out to be a no-op for web
> — see § "ADR-0024 — not applicable, and the ledger said otherwise".

## Purpose

Rung 2 is the bug rung. It mirrors four desktop ADRs that were each paid for
in production on the desktop side, none of which add a feature:

| Desktop  | Subject                                                  |
| -------- | -------------------------------------------------------- |
| ADR-0070 | Row-producing paths pin the simple/text wire protocol    |
| ADR-0081 | The statement-timeout variable is probed, not assumed    |
| ADR-0071 | An unreadable table degrades, it does not fail the sweep |
| ADR-0024 | At-rest permissions on `history.jsonl`                   |

Rung 1 established that the ADR text is a summary and the shipped code is the
authority. Applying that here changed the scope of three of these four rows
before a line was written. What the ledger said and what the code says are
recorded below in full, because the corrections are the more useful artifact.

## What the survey got wrong

### ADR-0070 — correct, and the fix is narrower than "add a test"

Ledger: _"`done by construction`, unpinned. Web calls `pool.query({ text })`
with no `values`, so node-postgres uses the simple protocol and returns text."_

Confirmed. `PostgresAdapter.executeQuery` calls
`this.pool.query({ text: sql, rowMode: "array" })`. No `values`, no `name`, so
pg takes the simple-query path and the server replies in text format. A second,
independent layer sits behind it: `createPostgresAdapter` overrides
`types.getTypeParser` to return the raw string for every OID, so
`pgOidToValue` is the only decoder.

Two layers, and **neither is enforced**. Adding a `values` array to fix a
future SQL-injection concern would flip the protocol and hand `pgOidToValue`
binary bytes — and desktop's own report is that the loud half of that failure
is the lucky half. A binary `int4` of `1` is `00 00 00 01`, which survives a
UTF-8 check and renders as four invisible control characters. Desktop shipped
that in v0.4.0.

### ADR-0081 — the ledger overstated the gap, and the real gap is worse than a missing timeout

Ledger: _"web's `PostgresAdapter` sends no timeout at all. A runaway query
holds a pool connection until the socket dies."_

Half wrong. `resolvePostgresPoolOptions` has had
`DEFAULT_STATEMENT_TIMEOUT_MS = 30_000` since the adapter landed, and passes it
to the pool — but as pg's **`query_timeout`**, which is not what the name
suggests. Read at `pg@8.21.0/lib/client.js:654`:

```js
const readTimeoutTimer = setTimeout(() => {
  const error = new Error('Query read timeout')
  process.nextTick(() => { query.handleError(error, this.connection) })
  ...
}, readTimeout)
```

It is a client-side timer. Nothing is sent to the server, no `CancelRequest`
is issued, and the socket is not destroyed. The client stops waiting; the
server carries on.

So the true state is worse than "no timeout" in one specific way: **the caller
is told the statement failed while it is still running, and — outside an
explicit transaction — will still commit.** A user whose `UPDATE` takes 31
seconds sees an error and gets the write anyway. That is a correctness bug, not
just resource hygiene.

pg does support the real thing. `getStartupConf` (`lib/client.js:543`) puts
`statement_timeout` into the startup packet, so it applies to every statement
on the connection for the life of the session — set once at connect, no
per-query `SET`, no extra round trip.

The **probe** half of ADR-0081 does not port. Desktop's probe exists because
MySQL and MariaDB disagree on the variable's name _and_ its unit. Desktop says
so directly: _"the Postgres adapter's `statement_timeout` has no such
divergence, so this stays MySQL-local."_ Web has no MySQL adapter (rung 7).
There is nothing to probe.

### ADR-0071 — no sweep exists, and the analogue is already handled

Ledger: _"web's `listTables` has no per-table guard."_

Misleading. `listTables` is a single `pg_tables` query, not a per-table walk.
The thing desktop's `list_relationships` does — iterate every listed table and
introspect each — has no counterpart here: `has_describe_table` is false and
there is no relationships endpoint.

Web's nearest analogue is the schema browser's lazy per-table column read
(`useSchemaBrowser.loadColumns`, a `SELECT * FROM t LIMIT 0` through the
existing query route). It already degrades exactly as ADR-0071 Decision 4
prescribes: `SchemaBrowser.vue` catches per table, caches
`{ state: "error" }` for that table alone, and renders a scoped error line
while the rest of the tree stays usable. It is tested — `schema-browser.test.ts`
_"renders the column-load error banner when LIMIT 0 fails"_.

**Nothing to do.** Recorded rather than silently dropped, because "the ledger
said todo and the code says done" is the kind of entry that gets re-opened by
the next reader if the reasoning is not written down.

### ADR-0024 — not applicable, and the ledger said otherwise

Ledger: _"desktop chmods the file it writes. Web writes the same file from the
API process and does not."_

**Wrong.** Web writes no file. `InMemoryHistoryStore` holds an array;
`ExportHistory` streams NDJSON over HTTP. A repo-wide search for
`writeFile` / `appendFile` / `createWriteStream` / `history.jsonl` in
`apps/api/src` returns nothing but the round-trip spec's fixture _reads_.

There is no at-rest surface to harden. Web's exposure is the transport:
`GET /history/export.jsonl` behind the bearer middleware — and, since rung 1,
that stream carries verbatim AI prompts, which is a fact `docs/deployment.md`
did not yet state. Fixed in this ticket.

If web ever persists history, this row comes back, and desktop's
`secure_fs::open_append_user_only` (single open with
`O_CREAT|O_EXCL|O_APPEND|mode(0o600)`, no close-and-reopen window) is the
reference.

## What the tests found that the survey did not

An unhandled-error crash on idle pooled connections. Not on any desktop ADR,
not in the ledger, and not something reading `postgres-adapter.ts` would have
surfaced — what surfaced it was the new integration tests changing teardown
timing.

The symptom: with the two new live tests added, `postgres-integration.spec.ts`
reported all 25 passing **and exited 1**, on `FATAL: terminating connection due
to administrator command` (SQLSTATE `57P01`) — the container's shutdown notice
arriving at a still-connected pool client.

The temptation is to read that as test-harness noise and quiet it. Two checks
said otherwise:

- stashing the new tests and keeping the production change → exit 0, so the
  change was not the cause;
- running a single **pre-existing** test in isolation, with and without the
  production change → **exit 1 in both**. The defect predates this ticket. The
  full suite happened to hide it, and adding tests happened to shift the timing
  that hid it.

What it means outside the test suite: a pooled client that errors while idle
has no in-flight query to reject, so pg emits `'error'` on the Pool. With no
listener, Node treats it as an unhandled `'error'` event and the process exits.
The triggers are routine — a database restart, an admin terminate, a pooler
recycling an idle connection (Neon and Supabase both do), an idle TCP reset.
The API had no listener. A Neon connection sitting idle overnight could take
the process down.

Fixed in `createPostgresAdapter` via `attachIdleClientErrorHandler`: log at
warn and stay up. There is nothing to recover — pg removes the broken client
itself and the next query opens a fresh one — so the listener's whole job is
existing.

Worth stating plainly because the near-miss is the lesson: **a green test count
with a non-zero exit code is a finding, not a formatting problem.** The
distinction between "the harness is flaky" and "the harness caught something"
cost two isolation runs and would have cost a production incident.

## Scope

**In:**

- `apps/api/src/infrastructure/postgres-adapter.ts` — reject a `binary`
  column format at decode time with a `QueryError` naming the cause
  (desktop ADR-0070 Decision 4: enforce at runtime, not behind an assertion
  that a release build compiles out).
- `apps/api/src/infrastructure/postgres-connection-config.ts` — resolve
  `statement_timeout` alongside the existing `query_timeout`, same budget,
  same override.
- `apps/api/src/infrastructure/postgres-adapter.ts` (factory) — pass it to
  `PoolConfig`.
- `apps/api/test/postgres-integration.spec.ts` — a live round-trip that
  asserts printed text for the three types desktop names (small `int4`, wide
  `int8`, `uuid`), and one that asserts the server-side timeout actually
  aborts.
- `docs/deployment.md` — the AI-prompts-in-export correction.

**Out:** the MySQL probe (no MySQL adapter), any change to `listTables`,
`SET LOCAL` / per-query timeouts, statement cancellation (`CancelRequest`),
and any at-rest work.

## Invariants worth stating before writing code

1. **`format === "binary"` is the rejection trigger, not `format !== "text"`.**
   pg's `Field.format` is `'text' | 'binary'` on the wire path
   (`pg-protocol/dist/parser.js:216`, `int16() === 0 ? 'text' : 'binary'`) but
   the property is absent from every hand-built stub in the existing specs,
   and `pg`'s own `result.js` defaults it (`desc.format || 'text'`). Treating
   absence as binary would fail ~30 tests and assert something the data does
   not say. Absence is not evidence.
2. **The guard belongs at decode, not at query submission.** Checking "did we
   pass `values`?" tests our own call site; checking the response format tests
   what the server actually did. The second one still fires if a future pg
   version changes when it prepares.
3. **`statement_timeout` and `query_timeout` are both kept.** They fail in
   different places and neither subsumes the other: the server one aborts the
   statement, the client one stops the caller waiting on a connection that has
   already gone away. Same 30 s budget, so the visible behaviour does not
   change — what changes is that the server now stops too.
4. **A startup-packet `statement_timeout` applies to writes as well as
   reads.** Desktop scopes its equivalent to the read-only transaction and
   clears MariaDB's before returning the connection to the pool (ADR-0081
   Decision 5), because a pooled connection still carrying it would kill a
   later restore's long `INSERT`. Web has no restore path (rung 6) and already
   caps every statement at 30 s client-side, so nothing a user can do today
   becomes newly impossible. When rung 6 adds a write path this constraint has
   to be revisited — noted here so it is not rediscovered.
5. **The timeout unit is milliseconds.** Postgres' `statement_timeout` takes
   ms when given a bare integer. pg stringifies via `parseInt`. Desktop's
   Decision 6 is that the unit is a tested fact rather than a comment; the
   same applies here even though there is only one unit in play.

## Acceptance

- [x] A `binary` column format raises `QueryError` naming the wire format,
      in a release build, not behind an assertion.
- [x] Every existing adapter spec still passes with stubs that omit `format`.
- [x] `resolvePostgresPoolOptions` returns `statement_timeout` on both the
      connection-string and the discrete-field paths, defaulting to 30 000 and
      honouring `statementTimeoutMs`.
- [x] The factory passes it to `PoolConfig`.
- [x] A live integration test asserts a small `int4` decodes as `1` — the
      case that fails silently rather than loudly — alongside a wide `int8`
      and a `uuid`.
- [x] A live integration test asserts a statement exceeding the timeout is
      aborted **by the server**, not merely abandoned by the client.
- [x] `docs/deployment.md` no longer claims AI calls stay out of the history
      log.
- [x] The four ledger rows are corrected to what the code says.
- [x] **Added mid-ticket:** an idle pooled client that errors no longer takes
      the API process down. See § "What the tests found that the survey did
      not".

## Verification

```sh
pnpm format:check && pnpm -r lint && pnpm -r typecheck && pnpm -r test
```

The two live assertions run under `postgres-integration.spec.ts`, which needs
a Docker daemon (testcontainers) and **skips rather than fails** without one.
A green local run without Docker does not prove them. Per rung 1's log, Docker
was up for that run; the same is required here.

## Log

- **2026-08-04** — opened. Three of four ledger rows were wrong or misleading;
  the corrections are in § "What the survey got wrong" rather than in a diff,
  because the reasoning is what stops them being re-opened.
- **2026-08-04** — landed. Two behaviours changed (binary-format rejection,
  server-side `statement_timeout`), two rows closed as no-ops with their
  reasoning recorded, and one unrelated crash fixed that the new tests
  exposed.

  Three things worth carrying to rung 3:

  **The ledger is a hypothesis about web, not just about desktop.** Rung 1's
  lesson was "read desktop's shipped code, not its ADR prose". Rung 2 needed
  the mirror image: every one of the three corrections came from reading
  `apps/api/src`. A parity row makes two claims, and the one about your own
  repo is the one you are more likely to accept unchecked.

  **The two rows that closed as no-ops took longer than the two that shipped,
  and that was the right allocation.** Deleting them would have left the next
  reader to re-derive the same conclusions from the same wrong text.

  **The bug the tests found outranks the bugs the survey found.** ADR-0070's
  guard protects against a refactor nobody has made yet. The idle-client crash
  was reachable today by a database restart.

  Verified in the api workspace with Docker up: unit specs green, and
  `postgres-integration.spec.ts` 25/25 with **exit 0** — the exit code is the
  assertion that matters here, since the failure mode was a passing run that
  still exited 1.
