# 0026 — Schema depth: describe a table, not just name it

**Status:** open (2026-08-05) · **Opened:** 2026-08-05 · **Rung 4** of
[`../parity-ledger.md`](../parity-ledger.md)

## Purpose

Rung 4 is the first rung that turns on a capability flag from rung 0. It
mirrors three desktop ADRs:

| Desktop  | Subject                                                     | Ledger status |
| -------- | ----------------------------------------------------------- | ------------- |
| ADR-0028 | `describe_table` — full per-column description of one table | `todo`        |
| ADR-0072 | Generated SQL follows the connection's identifier dialect   | `todo`        |
| ADR-0031 | Structure tab: inspect a table's columns                    | `partial`     |

Rungs 1–3 each established the same thing in a different way: the ledger row
is a hypothesis, the shipped code is the authority (baseline §19), and
re-deriving a rung can shrink it as easily as grow it. Applying that here
moved two of these three rows off the rung before a line was written. The
corrections are below in full, because they are the more useful artifact.

## What the survey got wrong

### The rung is not contract-visible

Ledger: _"Contract-visible — flips `has_describe_table`."_

Wrong on the first half. `docs/api-contract.md` in this repo is byte-identical
to the desktop's copy (modulo line endings), and the desktop's copy is the one
that gets drafted first (ADR-0004; the file says so in its own header). Two
facts settle whether rung 4 touches it:

1. **Desktop shipped ADR-0028 with no HTTP surface at all.** `describe_table`
   appears in `crates/dbboard-core`, `crates/dbboard-postgres`, the SQLite
   family and `crates/dbboard-ui`, and nowhere in `crates/dbboard-server`. The
   desktop UI calls it in-process. There is no route to mirror.
2. **The desktop ADR says web decides its own shape.** Its cross-repo section
   states that web "would decide its own DDL-fetching shape independently" and
   explicitly records that no brief is owed.

So the route this ticket adds is a **web-only unilateral surface**, the same
posture as `/connections/*` (PR #7) and `/ai/*` (ADR-0023 mirror decision,
`.claude/handoff/2026-06-24-ai-phase6-no-contract-mirror-incoming.md`).
`docs/api-contract.md` is not edited, and no outgoing handoff is owed.

The second half of the ledger row is right: the rung does flip
`has_describe_table`, which rung 0 mirrored into `NULL_CAPABILITIES` as
`false`.

### Flipping the flag is invisible to the UI as things stand

Not in the ledger at all, and it changes the slice list.

`GET /capabilities` resolves the **bootstrap** adapter — the one built from
`DATABASE_ADAPTER` at startup — not the connection the user is looking at.
Every real connection lives in the registry and carries its own adapter
(`POST /connections`). Setting `has_describe_table: true` on `PostgresAdapter`
therefore changes nothing observable: the only capabilities route reports a
different adapter, usually the null one.

Desktop does not have this problem because it has one backend at a time
(swapped via `swap_backend`, ADR-0020), so "the adapter" is unambiguous. Web's
per-connection registry is the divergence rung 0 already recorded. The
consequence lands here: a per-connection capabilities route is a prerequisite
for the flag to mean anything, not an optional extra.

### ADR-0028 — real work, and the column type must not be widened

Ledger: _"`todo` (rung 4) — sets `has_describe_table`."_ Correct, and
understated. Every part is missing:

| Desktop                                                                    | Web today                                           |
| -------------------------------------------------------------------------- | --------------------------------------------------- |
| `DatabaseAdapter::describe_table`                                          | no such method on `domain/database-adapter.port.ts` |
| `TableSchema { table, columns, primary_key }`                              | no such type                                        |
| `ColumnInfo` with `nullable` / `primary_key` / `ordinal` / `default_value` | `Column { name, declared_type }` only               |
| sidebar renders the described columns                                      | `SchemaBrowser.vue` renders name + `declared_type`  |

The trap is in the third row. Desktop keeps **two** column types:
`Column` in `row.rs` for query results, and `ColumnInfo` in `schema.rs` for
introspection. ADR-0028 widened `ColumnInfo` and left `Column` alone. Web has
mirrored only `Column` — and `Column` is on the shared wire, pinned by
`docs/api-contract.md § Column`. Widening it to carry nullability would be a
contract change to `QueryResult`, drafted on the desktop side, for no reason:
a query result genuinely has no primary key to report.

So rung 4 adds a **second** type rather than growing the existing one, matching
desktop's split.

There is also no cheap route to this data by the path web already uses.
`useSchemaBrowser.loadColumns` runs `SELECT * FROM <qualified> LIMIT 0` through
`POST /connections/:id/query` and reads the result's `columns[]`. Postgres'
`RowDescription` carries a name and a type OID per field and nothing else — no
nullability, no key membership, no default. The probe is not merely coarse; it
cannot be refined.

### ADR-0028's AI half has no precursor here — it moves to rung 8

Desktop's Decisions 8–9 add `SuggestRequest.full_schema: Option<Vec<TableSchema>>`
and an "include column details" checkbox that fans `describe_table` out over
the listed tables.

`full_schema` is **additive on top of** `SuggestRequest.schema: Vec<TableInfo>`
— the terse table-name list desktop has sent since Phase 6. Web's
`SuggestRequest` is `{ prompt: string; dialect?: string }`
(`apps/api/src/domain/ai/ai-provider.port.ts`): no `full_schema`, and no
`schema` either. Web's AI has never been told what tables exist.

Mirroring Decision 8 first requires building the half desktop already had, and
that half is AI-panel work — rung 8 (AI stage 2, ADR-0025 / 0026 / 0052).
Building it here would put an AI feature in the schema rung and still leave
rung 8 to revisit the same file. **Moved to rung 8**, recorded in the ledger.

### ADR-0072 — right in substance, wrong in timing: it moves to rung 7

Ledger: _"`todo` (rung 4) — the schema browser's identifier inserts quote
naively."_

"Naively" overstates it. `quoteIdent` wraps in `"…"` and doubles embedded `"`,
which is **correct** for every driver this codebase ships:
`static-adapter-factory.ts` accepts `"null"` and `"postgres"` and 404s anything
else, and the frontend's `Driver` union is `"postgres" | "null"`. There is no
connection today whose identifiers are quoted any other way. The gap is not a
defect; it is a correct choice that is not yet parameterised.

Porting `dialectForKind` now would produce a lookup table with one live entry
and no second dialect to distinguish it from — and it would also require
plumbing the driver into `SchemaBrowser.vue`, which today receives only
`connectionId`. Rung 3's ADR already set the standard for exactly this shape:
a tested module with no consumer "reads as parity while proving nothing."

**Moved to rung 7**, where the MySQL adapter that motivates it lands
(ADR-0068). Two things reduce the rung-7 cost rather than defer it whole:
slice E removes one of the two sites that generate identifier SQL (the
`LIMIT 0` probe stops being the primary path), and the driver plumbing is
needed by rung 7 anyway for the adapter picker.

### ADR-0031 — the depth lands in the sidebar; there is no tab to add

Ledger: _"`partial` — `SchemaBrowser.vue` lists tables and columns; the depth
ADR-0028 adds is the missing half."_ Confirmed, with one clarification worth
writing down so a later rung does not "finish" it.

Desktop renders the described columns in a **Structure tab** beside Results.
Web's equivalent surface is the docked schema sidebar, which already expands a
table to its columns inline. Adding a tab would duplicate a surface that
already exists and works on a phone, which the tab strip does not. Rung 4
deepens the sidebar rows; it does not add a tab. ADR-0031 closes as `done` on
that basis, not on a tab shipping.

## Scope

**In:**

- `TableSchema` + `ColumnInfo` domain values, mirroring desktop's `schema.rs`.
- `describeTable` on the adapter port (optional method), Postgres
  implementation, `has_describe_table` on the Postgres adapter.
- `GET /connections/:id/capabilities` so the flag is observable per connection.
- A web-only route returning a `TableSchema`.
- Sidebar depth: primary key, nullability, default, ordinal order — with the
  `LIMIT 0` probe kept as the fallback for adapters that do not describe.
- `schema.*` i18n keys across all 11 locales.

**Out, with the reason recorded above:** ADR-0072 (→ rung 7), ADR-0028
Decisions 8–9 (→ rung 8), foreign keys (desktop ADR-0054), table DDL (desktop
ADR-0049), indexes — the last three are explicitly out of scope in the desktop
ADR too.

## Invariants worth stating before writing code

1. **`Column` is not widened.** Introspection gets its own type. `QueryResult`
   on the wire is unchanged, so `docs/api-contract.md` stays a byte-mirror.
2. **Binding parameters is safe here, and rung 2's invariant does not forbid
   it.** Ticket 0024 pinned the _result format_, not the protocol:
   `assertTextWireFormat` rejects a field whose `format` is `binary`. A bound
   query takes pg's extended path, and pg-protocol's `bind` writes result
   format code `0` (text) unless `binary: true` is passed — verified in
   `pg-protocol/dist/serializer.js` (`writer.addInt16(binary ? 1 : 0)`) and
   `pg/lib/query.js` (`binary: this.binary`, unset by us). So `describeTable`
   binds `$1`/`$2` for the schema and table name rather than interpolating
   them, and the text-format guard still holds.
3. **Every value arrives as a string.** `createPostgresAdapter` overrides
   `types.getTypeParser` to the identity for every OID, so `ordinal_position`
   comes back as `"1"`, not `1`. The mapper converts explicitly and rejects a
   non-positive result, as desktop's `column_from_parts` does.
4. **A missing table is a query error, not an empty description.**
   `information_schema.columns` returns zero rows for an unknown relation
   rather than failing. Desktop turns that into `DbError::Query`; web raises
   `QueryError` (400) so the sidebar shows "no such table", not "a table with
   no columns".
5. **`primary_key` is reported twice and must agree.** The per-column flag and
   the table-level ordered list are both populated from the same query, as
   desktop's contract promises ("readers may trust either").
6. **An adapter that cannot describe says so.** `describeTable` is optional on
   the port; the use case raises `CapabilityError` (404) when it is absent, so
   `NullAdapter` needs no change and the frontend can fall back.

## Slices

Ordered so each one is independently green and the UI slice lands last.

| #   | Slice                       | Contents                                                                                                                                                                                |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Domain + port               | `ColumnInfo`, `TableSchema` in `domain/values`; optional `describeTable` on `DatabaseAdapter`; `DescribeTable` use case resolving via the registry, `CapabilityError` when unsupported. |
| B   | Postgres implementation     | Two bound `information_schema` queries (columns by `ordinal_position`, PK columns by key order); missing relation → `QueryError`; `getCapabilities` returns `has_describe_table: true`. |
| C   | Per-connection capabilities | `GET /connections/:id/capabilities`, sibling of `GET /connections/:id/tables`, resolving the registry's adapter.                                                                        |
| D   | Describe route              | `GET /connections/:id/table-schema?table=<name>&schema=<ns>` returning a `TableSchema`.                                                                                                 |
| E   | Sidebar depth               | `useSchemaBrowser` prefers the route when the connection advertises the flag and falls back to `LIMIT 0`; `SchemaBrowser.vue` renders PK / nullable / default; 11 locales.              |

**Why the identifier parts are query parameters, not path segments** (slice D):
a Postgres identifier may contain `/`, `%`, `?` and `#`, all of which have to
survive a round trip through a path segment intact. Nothing breaks if they are
percent-encoded correctly, but nothing checks that they were, and a table named
`a/b` failing to open is a bug that would surface only against one user's
schema. The response is a `TableSchema`, not a column collection, so
`/tables/:name/columns` would also under-name it.

## Acceptance

- [ ] `describeTable` on a Postgres connection returns every column in
      `ordinal_position` order, with `nullable`, `primary_key`, `ordinal`
      (1-based) and the raw `default_value` text.
- [ ] A composite primary key comes back in key order, and the per-column flags
      agree with the table-level list.
- [ ] A table with no primary key returns `primary_key: []` and no column
      flagged.
- [ ] An unknown table returns a `query` error (400), not an empty schema.
- [ ] `GET /connections/:id/capabilities` reports `has_describe_table: true`
      for a Postgres connection and `false` for a null one.
- [ ] `GET /connections/:id/table-schema` 404s with category `capability` on a
      connection whose adapter does not describe, and 404s on an unknown
      connection id.
- [ ] The sidebar shows the described columns on a Postgres connection and
      still shows name + type via the `LIMIT 0` probe on a null one.
- [ ] Every new `schema.*` key exists in all 11 locales
      (`i18n-locale-parity.test.ts` stays green).
- [ ] `docs/api-contract.md` is untouched and still byte-identical to the
      desktop copy.

## Verification

```sh
pnpm format:check
pnpm -r lint
pnpm -r typecheck
pnpm -r test
```

`pnpm -r typecheck` prints cosmetic `@vue/language-core` plugin noise — check
the exit code. `postgres-integration.spec.ts` skips without a Docker daemon;
CI has one.

## Log
