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
| `dbboard-config` | ADR-0038 | n/a — see E | E     |

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

> **Superseded by slice E's own work log below.** This paragraph reads the
> ledger's summary rather than the ADR, and gets the reason half right: the
> missing export surface is true but incidental. The ADR classifies web itself
> ("dbboard-web is unaffected"), and the payload is a keyring-reference map web
> could not fill even with an export surface. `n/a`, not deferred.

## Slices

| Slice | Subject                                            | Flag effect                 |
| ----- | -------------------------------------------------- | --------------------------- |
| A     | Turso / libSQL adapter (ADR-0003 → the crate)      | `has_table_ddl` varies      |
| B     | Cloudflare D1 adapter over `/raw` (ADR-0007)       | `has_atomic_restore` varies |
| C     | MySQL adapter (ADR-0068) + dialect seam (ADR-0072) | none — a third dialect      |
| D     | SSH tunnel (ADR-0069) **with** liveness (ADR-0092) | none — a lifetime           |
| E     | Connection bundle (ADR-0038): classify → `n/a`     | none                        |
| F     | Driver-aware connection form                       | none — a form               |
| G     | Closeout                                           | —                           |

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

### Slice B — Cloudflare D1 adapter over `/raw`

`sqliteJsonToValue` first, beside slice A's `libsqlValueToValue` in
`libsql-value-mapping.ts` — the same storage classes arriving as JSON
instead of as driver objects. Two arms disagree with the native mapper and
both are right where they stand: `true` is `1` here (JSON has a boolean and
SQLite does not, so the encoder spelled an INTEGER as a keyword) and an
array is a blob here (D1 sends bytes as numbers; the native driver sends an
`ArrayBuffer`). Then `D1Adapter` over a `D1Transport` seam, then the
factory, the two `AdapterConfig` ids and the two DTOs.

**One precision loss with no fix at this layer, recorded rather than
papered over.** `JSON.parse` narrows every number to a double before the
mapper is called, so a 64-bit INTEGER past 2^53 has already lost its low
bits. Slice A avoided this with `intMode: "bigint"`; there is no equivalent
switch on a response body. The fix — hand-parsing with a reviver that sees
the raw literal — is named in the mapper's doc comment as worth paying for
only if a real D1 database hands back rowids that large.

What is mirrored exactly is everything Cloudflare or SQLite decides: the
`sqlite_%` **and** `\_cf\_%` exclusions with their `ESCAPE '\'`, the
`[code] message` error join and its 2048-byte truncation, the PRAGMA
quote-doubling and by-name column lookup, the `ORDER BY (type = 'table')
DESC, name` DDL query, and the synthesised `no such table` message.

Three deliberate departures:

- **The endpoint is not configurable.** Desktop's `D1Config.base_url`
  exists for its own integration test; here the same field would let a
  request body aim an authenticated call anywhere. The transport seam
  covers the testing role, so the URL is a module constant.
- **The path ids must match `/^[A-Za-z0-9_-]+$/`.** They are interpolated
  into an authenticated URL, so `../../zones` would re-aim the call at
  another Cloudflare API. Refused at the factory — the level a request
  reaches — as well as pinned in the adapter's own tests.
- **A malformed body is a `ConnectionError`, where desktop says `Query`.**
  The house rule set in `turso-adapter.ts`: a 502 that turns out to be a
  bad query misleads far less than a 400 that turns out to be a dead
  server. An unparseable envelope is not a statement the caller can fix.

The row cap stays out of the adapter. `ROW_CAP` lives in `domain/limits.ts`
and `ExecuteQuery` applies it after the adapter returns, "so no adapter can
forget"; mirroring desktop's in-adapter `MAX_RESULT_ROWS` would cap twice
and give one condition two unequal errors. A 10 001-row envelope pins that
the adapter does not cap.

Flags: `has_describe_table`, `has_table_ddl`, `has_execute`.
`has_atomic_restore` stays false **with no `executeInTransaction` method at
all** — `/raw` takes one statement per request and has no multi-statement
transaction. That is the DoD item with teeth: `restore-database.d1.spec.ts`
drives `RestoreDatabase` with a real `D1Adapter` over a stubbed socket, so
the runner picks the per-statement branch itself rather than being told to
by a fake. `0030` slice D's branch stopped being dead code here.

`test/d1-integration.spec.ts` mirrors desktop's `rest_roundtrip.rs` behind
the same three env gates (`DBBOARD_D1_ACCOUNT_ID` / `_DATABASE_ID` /
`_TOKEN`), self-skipping with a printed reason. Unlike Postgres there is no
container to fall back on and unlike Turso no `:memory:`; baseline §15 puts
the credential in the maintainer's hands, so an unset run is the normal one.

Gate green: 945 API tests (78 files, +69, 1 file skipped), 1096 web, lint,
typecheck, format.

### Slice C — MySQL / MariaDB adapter, and the dialect seam it forced

`mysql-adapter.ts` mirrors desktop's `crates/dbboard-mysql/src/lib.rs`
(ADR-0068) read at `main` = b98f7a6, over `mysql2` rather than sqlx. What is
mirrored is the behaviour, not the driver: the same three catalog queries
verbatim, the same `CAST(ordinal_position AS SIGNED)` (since MySQL 8.0 the
information_schema is a view over the data dictionary and that column's type
varies by server), the same 2048-byte error truncation, the same refusal to
let a connection URL reach an error message, and the same TLS hardening.

**Dependency review (baseline §12) — `mysql2@3.23.2`.** MIT. No install
script and no native build: it is pure JS, which is the reason it is the
driver here rather than a binding. Eight runtime dependencies, all pure JS
and all already-known names — `aws-ssl-profiles`, `denque`,
`generate-function`, `iconv-lite`, `long`, `lru.min`, `named-placeholders`,
`sql-escaper`. No telemetry and no network egress beyond the MySQL socket it
is asked to open. It was already in the lockfile before this slice, as a
transitive of nuxt's `db0`, so the tree gains no new package — only a direct
edge from `apps/api`.

Two driver choices in `Mysql2Pool` are load-bearing rather than incidental,
and both exist to make desktop's decoding rule mean the same thing here:

- **`query`, not `execute`.** `execute` is the binary protocol, where a value
  arrives in its own type's encoding. `query` is the text protocol, where
  every value is the text MySQL would print — which is what desktop's sqlx
  `raw_sql` path sees, and what makes "valid UTF-8 or blob" the same
  question on both sides.
- **`typeCast: (field) => field.buffer()`.** Without it mysql2 converts each
  cell using the _declared_ column type, which loses exactly the distinction
  desktop keeps: a `BLOB` holding valid UTF-8 is text, and a `VARCHAR`
  holding invalid UTF-8 is not.

Metadata is decoded by different rules from data, and deliberately: an
information_schema cell that is not valid UTF-8 is a `SchemaError`, not a
blob. A name the caller cannot address the object with is worse than no
answer.

Three things in desktop's trait have no hook here and are absent rather than
written and unused: `ping`, `foreign_keys`, and `query_read_only` with its
`TimeoutStyle` machinery. That machinery exists to pick between MySQL's
`max_execution_time` (ms), MariaDB's `max_statement_time` (s) and MySQL
5.6's neither. Web has no read-only route, so there is nothing for the probe
to protect and no reason to carry three spellings of a variable this adapter
never sets.

TLS defaults to on. Desktop hardens sqlx's `Preferred`, which falls back to
plaintext silently; mysql2's default is worse, being no TLS at all. So
absent, `PREFERRED` and `REQUIRED` all resolve to an encrypted connection,
`DISABLED` stays plaintext for a deliberately insecure local node, and
`VERIFY_CA` / `VERIFY_IDENTITY` verify. `REQUIRED` maps to
`rejectUnauthorized: false` because that is what the word means in MySQL's
vocabulary — encrypt, do not verify — and it is the strongest thing
available while there is nowhere in the connection config to nominate a CA.

Flags: `has_describe_table`, `has_table_ddl`, `has_execute`, and -
uniquely so far outside Postgres — `has_atomic_restore`. A DDL statement
causes an implicit commit in MySQL, which would break the all-or-nothing
promise, but dbboard's logical dump is data-only (ADR-0049) so a restore
script emits no DDL, and for data an InnoDB transaction is exactly atomic.
`executeInTransaction` holds one pooled connection for the whole batch and
`destroy()`s it when the rollback itself fails — returning it would hand the
next caller an open transaction.

`test/mysql-integration.spec.ts` runs against a real `mysql:8` container via
testcontainers, with `DBBOARD_MYSQL_URL` as an override for a server the
maintainer already has. Unlike D1 there is no credential gate: the container
is the default path, so this suite runs on every machine with a Docker
daemon.

#### The dialect seam (ADR-0072)

MySQL is the first driver web ships that does not quote identifiers with
`"..."`, and `"orders"` there is a _string literal_ unless the server runs
with ANSI_QUOTES. In `FROM` that is a syntax error; in a `SELECT` list it is
worse, because a column reference quietly becomes a constant. So every
generated identifier had to become dialect-aware.

**Two dialect types, not one shared union.** `apps/api/src/domain/dialect.ts`
names `sqlite | postgres | mysql`; `apps/web/app/utils/sql-build.ts` names
`ansi | mysql`. The API's emitters also write _literals_, where SQLite and
Postgres part company (`X'...'` versus `'\x...'::bytea`); the browser
only ever writes identifiers, and there the two agree. One shared union
would import a distinction the frontend cannot act on and leave `sqlite` and
`postgres` as two names for the same branch.

`dialectFor` resolves anything it has not heard of to ANSI rather than
throwing (decision 1). `driver` is a `string`, not a union, because the API
can gain a driver without the browser bundle being rebuilt. The fallback
direction is the safe one and only just: ANSI is what every dialect except
MySQL accepts, and when it is wrong it is wrong loudly, as a syntax error
the user sees rather than a query against the wrong object.

**The `driver` option is getter-shaped, and that is the whole design.** The
SQL page has no `GET /connections/:id` to ask, so it finds the driver by
matching the route id against `useConnections().list` — an in-flight fetch
that usually resolves _after_ the sidebar mounts. Reading a plain string
once at setup would pin ANSI for the session and quietly break every MySQL
sidebar whose connection list was a tick slower than the page. So
`useSchemaBrowser` accepts `string | (() => string | null | undefined)` and
resolves per call, `SchemaBrowser.vue` passes `() => props.driver` down while
using a `computed` for its own three emit sites, and a test drives the
late-arrival case directly: mount with the driver absent, set it, then assert
the `LIMIT 0` probe back-quotes.

On the API side the parameter is `domain/dialect.ts`, whose `DEFAULT_DIALECT`
is `postgres` — web's spelling of ANSI there, because that arm is what every
emitter produced before the seam existed, so the fallback changes nothing that
already worked. It keeps two functions rather than one: `dialectForDriver`
answers `null` for a driver not in the table (desktop's `Option`), and
`dialectFor` applies the fallback. The split exists so a drift test in
`static-adapter-factory.spec.ts` can tell "not in the table" from "resolved to
the default" — which matters because for _literals_ the fallback is only safe
for Postgres, and a SQLite-wire driver reaching it dumps blobs Postgres-style.
That is exactly the bug slice B shipped for the length of one slice.

Of the four places the survey named, three took the parameter —
`sql-build.ts`, `domain/write-back.ts` and `domain/dump/literal.ts` (with
`insert.ts` and `select.ts` threading it through). **The fourth was wrong
about itself.** `domain/restore/plan.ts` quotes nothing at all: it splits a
script into statements and never emits an identifier, so there is no arm for a
dialect to pick. `domain/dump/table-ddl.ts`, which the survey did not name,
does have a private `quoteIdent` — but it is not the seam's, because the DDL
it wraps is the server's own text and re-quoting it in another dialect would
corrupt it. Both now say so in their module docs, so the next reader does not
have to re-derive the omission.

Gate green: 1029 API tests (81 files, +84, 1 file skipped), 1134 web, lint,
typecheck, format.

### Slice D — SSH tunnel (ADR-0069) with liveness (ADR-0092)

Five commits, bottom-up: `f5fc7ae` the pure domain, `3f6a257` the transport
and the liveness wrapper, `b7e0a21` the factory wiring, `3d9aa0c` the wire
shape and the host-key probe route.

Mirrors desktop's `crates/dbboard-tunnel` read at `main` = `b98f7a6`. The
behaviour, not the driver: desktop runs russh, web runs ssh2.

#### There is no blind-accept arm, and that shaped the domain

ADR-0069 Decision 2 is the part with no room to negotiate, so it is expressed
as a type rather than a check. `HostKeyPolicy` has two variants — a pinned
SHA-256 fingerprint, or a `known_hosts` text — and `resolveHostKey` demands
exactly one of them. A config naming neither does not fall back to accepting
whatever answers; it fails to resolve. There is no third variant to reach for,
so no later edit can add trust-on-first-use by passing a flag.

`verifyHostKey` returns three verdicts, not two, because "your pin no longer
matches" and "this host is not pinned yet" ask the operator for opposite
responses — investigate versus confirm — and a transport that reduces both to
"handshake failed" hides the one that matters. ssh2 does exactly that
reduction, which is why the verifier captures the domain verdict and the
transport prefers it over the driver's text. Desktop's `VerifyHandler` makes
the same move.

#### The wedge ADR-0092 names is web's by inheritance

The tunnel binds a guard to the adapter's lifetime, and `InMemoryConnectionRegistry`
hands out a cached live adapter with no eviction on failure and no health
check. So the moment a connection grows a tunnel it inherits the failure whole:
the bastion drops the session, the loopback listener keeps binding and keeps
accepting, and the pool heals forever against a forward with nothing behind it.
Shipping the tunnel without the liveness check would have been shipping a known
bug, which is why the survey called these one slice.

The check lives in `TunneledAdapter` rather than in the registry because web
keeps no keyring. The only copy of a live connection's credential is inside the
adapter serving it, so the wrapper is the only layer that can rebuild a forward
without asking the operator to re-enter one. A connection idle longer than one
keepalive interval pays for a `SELECT 1` before its next call; a failure tears
down forward and adapter and reopens them once, even when two callers arrive at
the same stale connection.

Three things ssh2 does not decide, so the transport does: keepalives on (30 s,
3 misses — off is what lets an idle tunnel die unnoticed), the rejection reason
above, and a probe timeout, because `probeHostKey` is reachable from an HTTP
route and a black-holed host would otherwise hold a request open for as long as
the TCP stack allows.

#### The whitelist trap, at its worst

Everything above was unreachable over HTTP until part 5. The global
`whitelist: true` pipe strips what no DTO declares, so a body carrying an `ssh`
block registered a perfectly ordinary connection and answered 201 — with no
error anywhere — going straight at the database the operator was tunnelling to
reach. Same trap as `authToken` in slice A and `accountId` in slice B, and the
worst instance of it in the ticket: the other two fail closed (a connection
that cannot authenticate), this one fails open.

`SshTunnelDto` is a nested class with `@ValidateNested()` rather than a bare
`@IsObject()`, because an object that is merely an object is un-whitelisted
inside — `privateKeyPath` would survive at the door. The domain ignores it
anyway, by reading only the eight names it knows, but not getting that far is
better than being ignored: web takes key _material_, never a path, so that the
API process never reads files off the server on request.

`host` and `user` are required in the DTO, which no other config field is. A
single field's presence is a shape question, not a cross-field one, and 422
states it more plainly than the 404 the domain resolver answers with. The
pairing rules stay in `resolveSshTunnelConfig` so they cover every caller and
not only the ones that arrived over HTTP.

#### `POST /connections/ssh/host-key`

The web half of desktop's `probe_ssh_host_key` (ADR-0076). POST despite reading
nothing, because it dials a host named in the request and GET is the shape
browsers and proxies feel free to prefetch; `@HttpCode(200)` because nothing is
created.

Two properties make it safe to expose and both live in `probeHostKey`: it never
authenticates — the key is captured and then refused, so no credential reaches
a host whose identity is still unverified — and it never writes. The answer
fills a form box; saving it stays a deliberate act rather than trust-on-first-use
behind a button, which the controller suite asserts by checking the registry is
still empty afterwards. The use case adds exactly one decision, the port
default, because a fingerprint fetched from `:22` and pinned against a tunnel
dialled at `:2222` compares two different hosts' keys.

It is an outbound dial on request, but not a new capability: `POST /connections`
already connects wherever the body says, the same bearer middleware covers it,
and `docs/deployment.md` already describes that exposure.

#### Known divergence, deferred to slice F

Desktop's `update_connection` takes `ssh: SshEditInput` with a `Keep` variant
(`to_ssh_edit_field`, `to_ssh_draft` in `apps/desktop/src-tauri/src/lib.rs`):
a blank secret box on the edit form means _keep the stored one_, matching
ADR-0080 for the database password. Web has no such variant. `optionalText`
maps `""` to `undefined`, and `resolveAuth` then fails "exactly one of
privateKey or password" with a 404 — so an edit form that re-submits an `ssh`
block with a blank credential box would break a working tunnel.

Not closed here because nothing submits that block yet: web's connection form
has no ssh fields until slice F, which is where the blank arrives and where the
fix belongs. Recorded so it is closed deliberately rather than discovered.

#### Dependencies (baseline §12)

`ssh2@1.17.0` and `@types/ssh2@1.15.5` were already in `pnpm-lock.yaml` as
testcontainers transitive deps, so slice D added a lockfile edge rather than a
package — zero downloads, nothing new to audit. It did falsify the
`ssh2: false` / `cpu-features: false` justifications in `pnpm-workspace.yaml`,
which claimed no SSH path was taken; both are rewritten. The denials stand:
ssh2's install script is a node-gyp rebuild of a _bundled optional_ crypto
binding it carries on without, and `cpu-features` is an accelerator, so
denying both keeps a compiler out of every install and CI job at the cost of
a slightly slower negotiation.

Gate green: 1170 API tests (88 files, 1 skipped), 1134 web, lint, typecheck,
format; PII scan clean on staged and message.

### Slice E — ADR-0038 classified: `n/a`, and the ledger row was wrong twice

The survey above said "deferred, not skipped" and pointed at the missing export
surface. Reading the ADR itself rather than the ledger's summary of it — the
§19 order, source before digest — found the classification already made, by
desktop, in the ADR's own Consequences:

> **Web sibling**: desktop-only feature, no HTTP wire-contract change, so
> dbboard-web is unaffected and no cross-repo brief is needed (same posture as
> ADR-0036/0037).

So the row was in the wrong table. Category A is for surfaces the two repos
share; a `.dbbx` file is not one, and the ADR says so in the same words web's
own ledger uses for ADR-0036/0037, which are already in Category C.

**The status was wrong on firmer ground than the missing export surface.** The
ledger's reason — "an _interop format_, so if web ever exports connections the
envelope has to match byte-for-byte" — supposes there is something to match.
There is not. The plaintext inside the age envelope is

```jsonc
{ "version": 1, "connections": { ...a ConnectionFile... }, "secrets": { "dbboard.<id>.<field>": "…" } }
```

and both members are already `n/a` here: the secrets map is keyed by _keyring
references_ (ADR-0013 / 0033, Category C — web has no keychain), and
`connections.toml` is not one of the two formats ADR-0004 shares. Web could
match the envelope byte-for-byte and still be unable to fill it. A future web
that persisted connections would not change that; it would have its own
document, and matching desktop's would mean adopting desktop's config file
rather than exporting web's own state.

**And the artifact does not keep its meaning across the gap**, which is the
part worth writing down because it would survive web gaining persistence.
Desktop's consequence reads:

> Anyone with both the file and the passphrase has every secret — the same
> trust boundary as handing over the secrets directly, but now in one step.

That equivalence holds because the import seeds an OS keychain scoped to one
user account. On web the same import would land in a process that answers to a
bearer token, so the boundary moves from _the person you handed the bundle to_
to _everyone who can reach the API_ — and it moves silently, because the file,
the passphrase prompt and the success message all look identical. A mirror
would carry desktop's security argument along with its bytes into a place where
the argument is false. The reference-collision refusal added in the ADR's
2026-07-16 hardening is a smaller instance of the same asymmetry: it defends a
keychain namespace web does not have.

No code, no test, no dependency. `age` is not evaluated under §12 because
nothing is being added — the finding is that there is nothing to add.

### Slice F1 — the non-secret half of a tunnel, remembered

A connection behind a bastion could be registered since slice D, and from that
moment nothing could describe it. `ConnectionRecord` kept `parts` — the
database endpoint minus the password — and kept nothing at all about the
tunnel, so `GET /connections` answered as though the connection were direct.
An edit form built on that answer cannot show the tunnel, and a form that
cannot show it cannot be trusted to leave it alone.

`SshParts` is the ssh counterpart of `ConnectionParts` and makes the same
argument ADR-0080 makes: name the non-secret half separately, and a prefill
built from it **cannot** leak the credential by oversight, because there is
nowhere to put it. The guarantee is in a type, not in care taken while
writing a projection — `sshPartsOf` reads its input through a parameter whose
`auth` member is narrowed to `{ kind }`, so the body could not reach the key
or the bastion password if it tried.

Every member is required, which `ConnectionParts` cannot say. A half-known
tunnel is not a thing: `resolveSshTunnelConfig` refuses a config missing any
of them, so a tunnel that is running has all of them. That is also why the
projection resolves first and reads second — a blank port becomes 22 here the
way it does when the forward opens, so a prefilled form describes the tunnel
that exists rather than the boxes that were typed into; and a block the
resolver would refuse raises `CapabilityError` instead of producing a
description of a connection that cannot exist.

**The divergence the whole ssh port carries shows up here as an absence.**
Desktop's `SshPrefill` carries a key _path_ and an `encrypted` flag, because a
path is not itself a secret. Web takes key _material_, so there is no
non-secret half of the credential to prefill and no flag to carry: `auth` says
which box to show, and the box starts empty.

Recomputed from the raw config at the use-case layer, exactly as
`connectionPartsOf(config)` already is, rather than returned from the adapter
factory. The factory's contract stays `create`/`rebuild` → adapter, so no fake
in any suite grew a member, and the two use cases that write records are the
two that describe them.

`update` deletes the description when an edit carries no `ssh` block, in
lockstep with the rebuild that just dropped the forward. A record still naming
a bastion the adapter has stopped using would show an edit form that
reinstates it on the next save. **Whether an absent block should instead mean
_leave the tunnel alone_ — desktop's `SshEditInput::Keep`, the divergence slice
D recorded — is F2's question**, and the test that pins today's behaviour says
so in its own comment rather than leaving the coming churn unexplained.

Nine tests: seven on the projection (including that a serialized `SshParts`
contains neither the key nor either password), two apiece on register and
update, one on the view. `ConnectionView` and its web-side mirror in
`useConnections.ts` gain `ssh?: SshParts` — absent for a direct connection,
which is a different statement from a tunnel whose details are unknown.

**A gate that was skipped came due here.** `apps/api` had not typechecked
since 3d9aa0c: `SshTunnelDto` is a class and `SshTunnelInput` declared an index
signature, which TypeScript grants implicitly to object literal types only, so
neither controller call site compiled. Fixed in 76492b4 ahead of this commit,
with the PDCA in its message. It survived four days because slice E was
docs-only and nothing has been pushed, so neither CI nor the pre-push hook ever
saw it — the pre-commit hook lints staged files and does not typecheck the
workspace. The rule that would have caught it is the one already written in
CLAUDE.md: run all four gate commands, not the ones the hook covers.

### Slice F2 — blank means keep, applied to the bastion

The divergence slice D recorded, closed. Desktop's `update_connection` takes
`ssh: SshEditInput` with three variants; web's `ssh` field had two states and
no way to say the third. `SshEdit` gives it the same three, spelled the way
JSON can spell them:

| wire         | desktop   | means                                              |
| ------------ | --------- | -------------------------------------------------- |
| field absent | `Keep`    | whatever bastion the connection is already on      |
| `ssh: null`  | `Disable` | take the bastion away                              |
| `ssh: { … }` | `Set`     | this bastion, with a blank credential meaning keep |

`graftSshTunnel(previous, edit)` is the whole of it, and it is a domain
function rather than a branch in the factory because the question it answers
— what tunnel is this connection on after this edit — is not about drivers.

**Only the credential is carried.** Host, port, user and host key are not
secrets, so the form renders them filled in, and an edit that omits one is an
edit that cleared it. Carrying those would make a cleared host key
unclearable, and an unverified bastion is what ADR-0069 refuses; a test pins
that an edit keeping its credential still has to name a host key.

The carry itself is `resolveAuth`'s, one argument wider: a `carried` auth is
used when _both_ credential boxes are blank. Both, not either — a caller
sending two credentials is ambiguous whether or not one is stored, and the
existing "exactly one of privateKey or password" refusal is the honest answer.
Registration passes nothing, so the carry arm is unreachable there and a blank
credential fails exactly as it did before.

**Where the description comes from had to move.** `sshPartsOf(config)` was
right in F1 and became wrong the moment a credential could be carried: an edit
that left the box blank describes a tunnel with no way in, while the tunnel
actually running has the stored credential. So `TunneledAdapter` now holds its
`SshTunnelConfig` rather than merely having dialled it, and answers two
questions about it — `describeTunnel()` for the record, and `carryTunnel(edit)`
for the next rebuild. The credential moves holder to holder exactly as
`rebuildWith` moves a database password; the factory sees it only as the config
it is about to dial. `openTunnel` takes that same held config, so what is
described and what is dialled cannot drift apart.

`AdapterFactory` gains `describeTunnel?(adapter)`, optional so that the fakes
standing in for tunnel-less factories across the suite did not all grow a
member. Both use cases now ask it instead of projecting the config, and the
Keep case then needs **no** special handling in `UpdateConnection`: a rename
never enters the rebuild branch, so the record's `ssh` is simply left alone —
and it is left alone on the strongest possible evidence, that the adapter was
not replaced.

`UpdateConnectionDto.ssh` becomes `SshTunnelDto | null`. `@IsOptional()`
already waved `null` past the validators, so this is a type change and not a
validation change — what it adds is the controller's ability to forward the
removal instead of narrowing it away. The three wire states each get an
end-to-end case, because each of them has a way to fail silently at the pipe:
`null` coerced to `undefined` would read as Keep, a stripped block would answer
200 on a connection still going direct, and an absent block that rebuilt would
drop a working forward.

Sixteen new or rewritten tests across five files. `sshPartsOf` was repurposed
from input→parts to config→parts, which is the same projection one step later
and let its two resolver-concern tests go; `classifySshEdit` was designed and
then not written, having no caller.

### Slice F3 — asking the bastion what key it presents

`useSshHostKey` wraps `POST /connections/ssh/host-key`, which has existed
server-side since slice D with nothing in the browser calling it.

It is the first composable here that does **not** fetch on mount. `useDrivers`
reads a fact about the API build and costs nothing; this dials a machine the
operator named, and ADR-0076 makes it a button precisely so that it happens
once, deliberately, against a hostname somebody finished typing.

Three behaviours are load-bearing rather than incidental:

- **A blank host is refused without a round trip.** The server would answer
  422, but the trip would also blank the previous answer and dress a form
  mistake as a server error.
- **A blank port box sends no `port` at all.** `ProbeSshHostKey` resolves the
  default, and the tunnel dials with the same one. A copy in the browser could
  drift, and then the fingerprint on screen would belong to a different
  listener than the one the tunnel connects to — the comparison would pass
  while comparing two hosts.
- **The stored fingerprint is cleared when a probe _starts_, not when it
  succeeds.** A key left on screen while a different host is being probed is
  the only way this composable could get someone to pin the wrong one.

The fingerprint is both returned and stored: the caller that pressed the button
decides whether it goes into the field. Nothing here judges the key — that a
human compares it against a value obtained out of band is the entire reason
ADR-0069 makes host-key verification mandatory rather than automatic.

Seven tests (fourteen runs, two environments).
