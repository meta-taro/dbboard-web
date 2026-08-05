# 0029 — Logical dump: reading a whole database back out as SQL

**Status:** open (2026-08-05) · **Opened:** 2026-08-05 · **Rung 6b** (first of
two tickets) of [`../parity-ledger.md`](../parity-ledger.md)

## Purpose

Rung 6b is dump and restore. They are separable — each has its own capability
flag, each is useful without the other, and restore's hardest problem (getting
a `.sql` script past an API built for JSON) has nothing to do with dump's
(rendering typed cells as literals that re-parse). So the rung carries two
tickets:

| Ticket | Subject                     | Desktop         | Flag                 |
| ------ | --------------------------- | --------------- | -------------------- |
| `0029` | Logical dump — **this one** | ADR-0049 / 0050 | `has_table_ddl`      |
| `0030` | Restore                     | ADR-0051        | `has_atomic_restore` |

`has_execute` is **not** in that table. Rung 6a already flipped it (`e71edf0`),
because the write-back route needed `DatabaseAdapter.execute` and the flag
travels with the method. The ledger and `project-status.md` said otherwise
until `62e2679` corrected them.

Annotations (desktop ADR-0045) close `n/a` with the rung, for the reason ticket
`0028` derived: the ADR declares itself desktop-only, and web's
`InMemoryConnectionRegistry` mints connection ids per process, so there is no
stable anchor to key a note on.

## Survey

Per baseline §19 the shipped code is the authority. Desktop is at `0ffb93f`;
the dump implementation is `crates/dbboard-core/src/dump/` (insert.rs 209,
literal.rs 236, mod.rs 33, plan.rs 161, run.rs 872, select.rs 197) plus
`crates/dbboard-postgres/src/table_ddl.rs` (335) and its four catalog queries,
which live in `crates/dbboard-postgres/src/lib.rs` as `DDL_COLUMNS_SQL`,
`DDL_CONSTRAINTS_SQL`, `DDL_INDEXES_SQL`, `DDL_SEQUENCES_SQL`.

Five things on web's side change the design, and none of them are visible from
the desktop ADR.

### 1. Web's `Value` has no integer/real distinction — and that breaks bare literals

Desktop's `value_literal` switches on a five-variant `Value` and renders
`Integer` and `Real` as bare decimals. Web's `Value` is
`null | number | string | BlobValue` (`apps/api/src/domain/values/value.ts`) —
JSON has no integer type, so the distinction was collapsed at the contract
boundary long before dump existed.

The collapse is survivable. What is not is what sits under it:
`pgOidToValue` maps `BOOL` to `1` / `0`
(`apps/api/src/infrastructure/postgres-type-mapping.ts:89`). Render that as a
bare decimal and the dumped `INSERT INTO t (flag) VALUES (1)` fails to load —
Postgres will not assign an `integer` to a `boolean` column. The dump would be
syntactically valid and semantically broken, which is the worst available
outcome for a backup.

**Decision: one literal form for everything except `NULL` and blobs.** Every
`number` and every `string` is emitted as a single-quoted literal, and the
target column's type coerces it. Postgres resolves an `unknown`-typed literal
against the column it is being assigned to, so `'1'` lands correctly in
`boolean`, `integer`, `numeric`, and `text` alike.

This is not a new idea in this codebase — it is exactly the rule rung 6a wrote
into `write-back.ts`: _"the editor produces text and only text, so every value
goes out as a string literal and the engine coerces it by the target column's
type."_ Dump adopts the same rule for the same reason, and inherits its
`quoteLiteral`.

Two consequences fall out for free:

- **Non-finite reals need no special case.** `FLOAT8` decodes through
  `Number(s)`, so unlike desktop's Postgres path web genuinely can hold a
  `NaN` or `Infinity` in a `Value` — and `'NaN'` and `'Infinity'` are precisely
  how Postgres spells them as literals. Desktop needs `real_literal`'s
  six-branch dialect table because it renders bare; web does not need the
  function at all.
- **A dumped `.sql` is Postgres-family only.** It relies on assignment casts
  from unknown literals. Web ships nothing else (rung 7 brings MySQL, and the
  dialect parameter arrives with it, on these functions rather than as a second
  copy of them — the same narrowing `write-back.ts` already documents).

Blobs keep their own form: `'\x…'::bytea`, hex-encoded, matching desktop's
Postgres branch.

### 2. The 10 000-row cap is on the response, not on the read

`ROW_CAP` (`apps/api/src/domain/limits.ts`) is enforced by the `ExecuteQuery`
usecase, not by the adapter. Dump does not go through that usecase, so the cap
does not bound it — but the reason for paging is unchanged: a table read whole
is a table held whole in memory. Dump pages for the same reason desktop does,
and stays well under `ROW_CAP` per page so the number never becomes load-bearing
in two places.

### 3. `ExportHistory.stream()` is the streaming precedent

```ts
async *stream(): AsyncIterable<string> {
  for await (const record of this.store.iterate()) {
    yield `${JSON.stringify(record)}\n`;
  }
}
```

A usecase that is an async generator, with the controller doing the piping and
the headers. Dump is the same shape at a larger size: yield SQL text per
statement, never assemble the script in memory. This also settles what "cancel"
means on web — desktop runs an in-process worker with a cancel token; web has a
client that can abort the request, which tears down the generator. There is no
progress channel over a plain download, and this ticket does not invent one.

### 4. The catalog queries are already a solved pattern

`PostgresAdapter.describeTable` runs parameterised catalog queries via
`this.pool.query({ text, values })` and guards each result with
`assertTextWireFormat`. The four DDL queries mirror straight onto that. The
split desktop draws — queries in the adapter, assembly in a pure module — maps
onto web's layering without argument: the assembler is `domain`, the queries
are `infrastructure`.

### 5. Dump is not a query, so it is not history

`RecordHistory` is wired into the query path. A dump is a download, not a
statement the user typed, and desktop does not log it either. Nothing to do
here beyond not doing it.

## Deliberate divergences from ADR-0049

Recorded here so the closeout ADR does not have to rediscover them.

| ADR-0049 decision                                      | Web                                                                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Total dialect-aware literal rendering                  | One literal form (quoted) + `NULL` + bytea. No dialect parameter until rung 7. See §1.                                                   |
| SQLite verbatim from `sqlite_master`                   | `n/a` — web ships no SQLite-family adapter.                                                                                              |
| In-process worker with cancel and progress             | An HTTP stream. Cancel is the client aborting; there is no progress channel.                                                             |
| Warn-and-allow at `DEFAULT_BACKUP_WARN_ROWS = 500_000` | Kept, as a preflight gate on the route rather than a modal: over the threshold the request fails naming the count unless `confirm=true`. |
| Postgres reconstructs DDL from catalog                 | Kept verbatim — the four queries port as-is.                                                                                             |
| DSQL degrades (no sequences, no FK catalog)            | Kept. An empty result from a catalog query is an empty section, never an error.                                                          |
| Keyset pagination under `MAX_RESULT_ROWS`              | Kept, under a page size of web's own choosing. See §2.                                                                                   |
| Partial failure is non-fatal                           | Kept — a table that fails to read becomes a SQL comment in the output and the dump continues.                                            |

## Plan

Slices land as separate commits. Each is RED before GREEN (baseline §4 / §20).

- **A — literals and `INSERT` assembly.** `apps/api/src/domain/dump/literal.ts`
  and `insert.ts`. Pure. `valueLiteral(value)` and
  `buildInsert(table, columns, rows)`. Reuses `quoteIdent` / `quoteLiteral` /
  `qualifiedTable` from `write-back.ts` rather than restating them. Adversarial
  tests: embedded quotes, backslashes, empty strings, blobs, `NaN`, `Infinity`,
  a `number` that is really a boolean.
- **B — page and count SELECTs.** `apps/api/src/domain/dump/select.ts`. Pure.
  `buildSelectPage(table, keyColumns, limit, after)` with the row-value
  comparison cursor, and `buildCount(table)`. Composite keys and the
  no-primary-key case (one unordered page, no paging).
- **C — `tableDdl`.** An optional `tableDdl?(table): Promise<string>` on
  `DatabaseAdapter`, a pure `assembleTableDdl(input)` in
  `apps/api/src/domain/dump/table-ddl.ts`, and the four catalog queries in
  `PostgresAdapter`. **Flips `has_table_ddl`.** Sequences first, then
  `CREATE TABLE` with inline constraints verbatim from `pg_get_constraintdef`,
  then standalone indexes from `pg_get_indexdef`.
- **D — the dump usecase.** `DumpDatabase` in `apps/api/src/usecase/`: plan
  (list tables, per-table counts, the warn gate), then run as an async
  generator (header comment, per table: DDL then paged `INSERT`s; a failed
  table becomes a comment and the dump continues).
- **E — route and download.** `GET /connections/:id/dump` streaming
  `application/sql` with `Content-Disposition`, plus the button and the i18n
  keys across all 11 locales. The locale parity test makes new keys
  all-or-nothing, so they land with the behaviour that names them — same
  boundary rung 6a's slice E used.
- **F — closeout.** ADR in `.claude/decisions.md`, ledger row, status, this
  ticket's log, contract zero-diff against `86b324f`.

## Acceptance criteria

- `has_table_ddl` is `true` for the Postgres adapter and `false` for
  `NullAdapter`, and the capabilities route reports it.
- A dump of a table containing every `Value` shape — null, integer, float,
  boolean-as-number, text with `'` and `\`, blob, `NaN` — re-loads into an
  empty database and reproduces the rows.
- A table whose read fails leaves a comment in the output and does not abort
  the dump.
- A composite-key table pages correctly; a key-less table yields one page.
- The 500 000-row gate refuses without `confirm=true` and names the count.
- The response streams: the usecase never holds the whole script.
- `docs/api-contract.md` diff against `86b324f` is empty (dump is a
  `/connections/*` route, which is web-unilateral).
- Gate green: `pnpm format:check`, `pnpm -r lint`, `pnpm -r typecheck`,
  `pnpm -r test`.

## Log

_(slices append here)_
