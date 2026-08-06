# 0031 — Adapters: the databases web cannot reach

**Status:** open (2026-08-06) · **Opened:** 2026-08-06 · **Rung 7** of
[`../parity-ledger.md`](../parity-ledger.md)

## Purpose

Every rung-0 capability flag is now `true` for Postgres. The remaining distance
to desktop is no longer about what web can do to a database — it is about which
databases web can reach at all. Desktop ships four engine families across three
dialects; web ships one driver plus `null`.

| Desktop crate    | ADR      | Web today   | Slice |
| ---------------- | -------- | ----------- | ----- |
| `dbboard-turso`  | ADR-0003 | absent      | A     |
| `dbboard-d1`     | ADR-0007 | absent      | B     |
| `dbboard-mysql`  | ADR-0068 | absent      | C     |
| `dbboard-tunnel` | ADR-0069 | absent      | D     |
| —                | ADR-0072 | ANSI only   | C     |
| —                | ADR-0092 | no liveness | D     |
| `dbboard-config` | ADR-0038 | no export   | E     |

`CLAUDE.md` names Turso/libSQL a target database and no adapter exists. That
documentation contradiction is why Turso goes first even though it is not the
adapter that teaches the most.

## Survey

Per baseline §19 the shipped code is the authority, and this rung is where the
last ticket's lesson gets applied before it costs anything rather than after.

### The pin, and why it needed checking

Desktop's working checkout is on `feature/nested-value` at `468fc44`, a branch
no mainline contains. Mainline is `main` = **`b98f7a6`** (v0.5.1) with
`develop` = `35f5910` one docs-only commit ahead (`.claude/next-actions.md`,
`.claude/project-status.md` — verified with `git diff --stat`). **This rung is
surveyed at `b98f7a6`**, the ledger's re-pinned ceiling.

Ticket `0030` found its own pin sitting on an unmerged branch after the work
was done. Here the same check ran first, and it changed an answer: `468fc44` is
"feat: give Value a nested variant so a document store can return a row" —
ADR-0091's Decision 2, the wire tag web is waiting to mirror. It is **not
shipped**. `docs/api-contract.md` on mainline does not carry the tag, so the
watch item stays a watch item and nothing in this rung mirrors it. Had the
survey read HEAD, web would have mirrored a contract change desktop has not
made.

### ADR-0003 is a process ADR, not an adapter specification

It says "ship a vertical slice against Turso first, extract the trait after" —
a Phase-1 sequencing decision from 2026-05-19, with consequences about what may
not compile. It contains no adapter contract. The ledger row
(`Turso / libSQL adapter`) reads as though it does. **The contract for slice A
is `crates/dbboard-turso/src/lib.rs` (967 lines) and its `in_memory.rs`
integration test** — the ADR is context, not spec. Row corrected in the ledger.

### Turso, not D1, is the first adapter to report a flag `false`

The ledger's rung-7 row says D1 is "the first adapter that must report a
capability flag `false` that Postgres reports `true`". Reading the three
`capabilities()` implementations at `b98f7a6` says otherwise:

| Flag                 | Postgres | Turso     | D1        | MySQL |
| -------------------- | -------- | --------- | --------- | ----- |
| `has_describe_table` | true     | true      | true      | true  |
| `has_execute`        | true     | true      | true      | true  |
| `has_table_ddl`      | true     | **false** | true      | true  |
| `has_atomic_restore` | true     | true      | **false** | true  |

`dbboard-turso` has no `table_ddl` at all — the string does not appear in the
crate — so its `..Capabilities::default()` tail leaves the flag `false`. Turso
lands in slice A and D1 in slice B, so the first varying flag is
`has_table_ddl`, one slice earlier than the row claims, and the two flags fail
in different directions: Turso can restore a dump it cannot produce, D1 can
produce a dump it cannot restore atomically. Row corrected.

That second half is the one with teeth. `0030` slice D shipped a per-statement
restore branch and recorded it as dead code until an adapter reports
`has_atomic_restore: false`. **Slice B is that adapter.** The branch stops
being hypothetical and starts being tested against a real engine.

### Web's `Capabilities` has nine flags; desktop's has ten

Desktop carries `has_foreign_keys` (ADR-0054) and web does not. Nothing in this
rung changes that — no web surface consumes foreign-key edges — but every
adapter added here must be re-read when ADR-0054 is classified, because three
of the four desktop adapters set that flag `true`.

### The dialect seam was left open on purpose, in four places

`sql-build.ts` (frontend), `write-back.ts` (domain), `dump/literal.ts`
(domain), and `restore/plan.ts` all quote ANSI and all say in a comment that
the dialect parameter arrives with MySQL in rung 7. ADR-0072 is why they say
so: MySQL reads `"orders"` as a string literal without `ANSI_QUOTES`, so ANSI
quoting there is wrong rather than merely redundant. ADR-0068 Decision 1 adds
three more MySQL arms beyond quoting — back-slash **and** doubled-quote string
escaping, `NaN`/`±Inf` dumping as `NULL`, and the shared `X'…'` blob literal.

ADR-0072 Decision 1 also fixes the fallback direction: unknown kinds resolve to
ANSI, because it is what every adapter except MySQL accepts and therefore the
right guess for an adapter added after the table. Slice C inherits that, which
matters because slices A and B add two such adapters first.

`SchemaBrowser.vue` takes only `connectionId` and calls `quoteIdent` directly
(line 6, line 95). The driver has to reach it before the dialect can.

### ADR-0069 and ADR-0092 are one slice, not two

The tunnel decorator binds a guard to the adapter's lifetime (Decision 3), and
ADR-0092 is the bug that shape produces: the bastion drops the session, the
loopback forward still binds and still accepts, and the pool heals forever
against a dead forward. Web's `InMemoryConnectionRegistry` hands out a cached
live adapter with no eviction on failure and no health check, so it inherits
the wedge whole the moment it grows a tunnel. Shipping the tunnel without the
liveness check would be knowingly shipping a known bug.

The plain-TCP half does not apply and that was checked rather than assumed:
`pg`'s Pool drops a client that errors while idle and the next query re-dials,
which is exactly what rung 2's `attachIdleClientErrorHandler` logs and declines
to recover from.

ADR-0069 Decision 2 is the part with no room to negotiate: **there is no
blind-accept variant in the type.** Two verifying modes — a pinned SHA-256
fingerprint or a `known_hosts` match, with a mismatch distinct from an unknown
host — plus a `probe_host_key` that reads the fingerprint without
authenticating so first-time pinning is usable.

### ADR-0038 is deferred, not skipped

The bundle exists to move a connection set to another machine, because desktop
stores keyring _references_ and the TOML alone is useless elsewhere. Web has
neither problem: `InMemoryConnectionRegistry` mints ids per process and there
is no export surface at all. Slice E writes that reasoning down and classifies
it; it does not implement a `.dbbx` reader web has nothing to read into.

## Slices

| Slice | Subject                                            | Flag effect                 |
| ----- | -------------------------------------------------- | --------------------------- |
| A     | Turso / libSQL adapter (ADR-0003 → the crate)      | `has_table_ddl` varies      |
| B     | Cloudflare D1 adapter over `/raw` (ADR-0007)       | `has_atomic_restore` varies |
| C     | MySQL adapter (ADR-0068) + dialect seam (ADR-0072) | none — a third dialect      |
| D     | SSH tunnel (ADR-0069) **with** liveness (ADR-0092) | none — a lifetime           |
| E     | Connection bundle (ADR-0038): classify             | none                        |
| F     | Closeout                                           | —                           |

Slice order is dependency order, not value order. A and B are both SQLite-wire
and share a value mapping; C needs the dialect seam that A and B make
non-trivial (two more kinds in the fallback table); D needs an engine behind a
bastion to be worth having, which is C.

## Definition of done

- Each adapter answers `GET /connections/:id/capabilities` with flags that
  match its shipped desktop counterpart, and the flags travel with the methods:
  a flag is `true` only where the optional hook exists.
- The restore per-statement branch is exercised against D1, not only in a unit
  test with a stub.
- `dialectFor` resolves an unknown kind to ANSI, and a MySQL connection's
  generated SQL back-quotes in all four places the seam was left open.
- No tunnel path connects without a pinned fingerprint or a `known_hosts`
  match; the mismatch case is distinguishable from the unknown-host case.
- A cached adapter that has gone stale is evicted rather than handed out.
- Full gate green per `CLAUDE.md`; PII scan clean on staged, tree, and message.

## Work log

### Slice A — Turso / libSQL adapter

`libsql-value-mapping.ts` first (the wire→`Value` half both SQLite-wire
adapters share), then `TursoAdapter` on top of it, then the factory,
`AdapterConfig.authToken` and the two DTOs.

Every behaviour was probed against a live `@libsql/client` before it was
mirrored, and two of desktop's shapes turned out to be Rust-driver
constraints rather than engine facts. Both are recorded in the adapter
header with the reason and pinned by a test:

- **No `is_row_returning` router.** The JS `execute` takes DML and SELECT
  alike and reports `rowsAffected` either way, so desktop's first-keyword
  classifier would only be a chance to get the keyword list wrong. Pinned
  by an INSERT sent through `executeQuery`.
- **No hand-rolled BEGIN/COMMIT/ROLLBACK.** `batch(…, "write")` owns the
  transaction and rolls back itself, so there is no window where a failed
  rollback strands the session mid-transaction. Pinned by a duplicate-PK
  batch that leaves zero rows — the whole promise `has_atomic_restore`
  makes to the restore runner.

What is mirrored exactly is everything the engine decides: the `sqlite_%`
filter, the PRAGMA quote-doubling, the 1-based ordinal, the composite-key
ordering, and the synthesised `no such table` message.

Two things web needs that desktop does not:

- **Remote schemes only.** Desktop takes the URL from the operator of the
  machine it runs on; web takes it from an HTTP request body, where a
  `file:` URL would open any SQLite file the API process can read and hand
  its contents back through `GET /tables`. `createTursoAdapter` refuses
  anything outside `libsql:`/`https:`/`http:`/`wss:`/`ws:`, and the
  refusal is tested at the factory as well as in the adapter — the factory
  is the level a request actually reaches. Tests use
  `new TursoAdapter(client)` to get at `:memory:`, the same split
  `createPostgresAdapter` / `new PostgresAdapter(pool)` already has.
- **Token redaction.** The token is kept only so driver messages that echo
  the request URL cannot put a bearer credential in an HTTP error body.

`authToken` is its own `AdapterConfig` field rather than a reuse of
`password`: they resolve differently and a form labelling a Turso token
"password" would be lying about what to paste in. It carries forward
across an edit exactly as `password` does (ADR-0080), blank included —
an edit form never prefills a credential box, so `""` means untouched.
`connectionPartsOf` structurally cannot read it, so it does not leak to a
client.

Flags: `has_describe_table`, `has_execute`, `has_atomic_restore`.
`has_table_ddl` stays false, with no `tableDdl` method, because desktop's
crate has no `table_ddl` — SQLite does keep the DDL in
`sqlite_master.sql`, so closing this gap here would make web's
capabilities an opinion rather than a mirror.

Gate green: 876 API tests (75 files, +44), 1096 web, lint, typecheck,
format.

_(slice B next)_
