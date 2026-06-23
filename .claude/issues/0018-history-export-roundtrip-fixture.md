# 0018 — Phase 5 closeout: desktop `history.jsonl` round-trip cross-check

- **Status:** open (scaffold + brief landing today; fixture awaited from desktop)
- **Phase:** Phase 5 (closeout)
- **Opened:** 2026-06-23
- **Closed:** —
- **Branch:** none (direct-to-`develop`, per the Phase 4 / Phase 5 slice pattern)
- **Depends on:** [`0009`](./0009-web-history-schema-mirror.md) (the Zod schema mirror + `GET /history/export.jsonl` egress this ticket cross-checks), [`0015`](./0015-frontend-history-sidebar.md) (the UI consumer that has been parsing the same stream since slice 1).
- **Blocks:** the Phase 5 closeout brief back to desktop. Schema browser + history sidebar are already on `develop`; what's left of Phase 5 is proving the export endpoint actually round-trips against a _real_ desktop fixture instead of synthesised records.

## Goal

Close the last open Phase 5 acceptance line in [`roadmap.md`](../roadmap.md#phase-5--schema-browser--query-history):

> Export endpoint streams `application/x-ndjson` records that round-trip via `jq -c .` against a desktop `history.jsonl` fixture. **[done, 0009-impl — `f8154c3`; round-trip cross-check against an actual desktop fixture still pending]**

The 0009 implementation already proves byte round-trip at the unit level using web-side synthesised records (`history-record.spec.ts`, `export-history.use-case.spec.ts`, `history.controller.spec.ts`). What it does _not_ prove is that bytes written by desktop's `serde_json::to_string(&RecordWire)` (the production write path in [`crates/dbboard-ui/src/history.rs`](https://github.com/meta-taro/dbboard/blob/develop/crates/dbboard-ui/src/history.rs)) parse through web's `historyRecordSchema` and re-emit through `ExportHistory.stream()` to byte-identical output. That cross-implementation byte equivalence is the contract ADR-0017 §8 implies: "`cat dbboard-history.jsonl | curl --data-binary @-` round-trips" (handoff brief §"Storage", lines 141–145).

## What this is — and what it isn't

**Is:**

- A new fixture file shipped under `apps/api/test/fixtures/desktop-history.jsonl` containing bytes produced by desktop's `RecordWire` serialiser. Source: the desktop agent emits a representative set via a small fixture-emit helper (see the handoff brief at [`../handoff/2026-06-23-history-fixture-emit-outgoing.md`](../handoff/2026-06-23-history-fixture-emit-outgoing.md)); web commits the resulting bytes verbatim.
- A new vitest spec at `apps/api/test/desktop-history-roundtrip.spec.ts` that, for each fixture line:
  1. Parses via `JSON.parse` and asserts the canonical-form invariant `JSON.stringify(JSON.parse(line)) === line.trimEnd()` (the `jq -c .` byte equivalence on a per-line basis).
  2. Validates via `historyRecordSchema.safeParse(parsed).success === true` (web's Zod mirror accepts every desktop line).
  3. Pushes the parsed record into an `InMemoryHistoryStore`, calls `ExportHistory.stream()`, and asserts the streamed line equals the original fixture line byte-for-byte (re-export round-trip — proves the production egress path preserves bytes, not just JSON-semantic equivalence).
- A forward-compat fixture line carrying an unknown field (per the brief's §"Forward-compat policy" and ADR-0017 §6) plus an assertion that web silently strips the field on re-emit. This is the only fixture entry that intentionally diverges between source and re-emitted bytes; the spec captures the strip explicitly.
- A new ADR entry in [`.claude/decisions.md`](../decisions.md) — "2026-06-23 — Desktop `history.jsonl` fixture provenance + drift policy" — pinning the fixture as bytes from desktop's `serde_json::to_string(&RecordWire)`, and stating that any divergence in canonical bytes is a cross-repo coordination event (not a web-side patch).
- A `.gitignore`'d slot under `apps/api/test/fixtures/local-history.jsonl` plus a `README.md` in that directory recording the recipe so the maintainer can drop a real interactively-generated dump in for ad-hoc verification without committing it (e.g., extracts from `%APPDATA%\dbboard\dbboard\config\history.jsonl` on Windows or the `directories::ProjectDirs` equivalent on macOS / Linux). The spec optionally picks up `local-history.jsonl` if present and runs the same assertions against it, gated on `process.env.DBBOARD_LOCAL_HISTORY_FIXTURE === "1"`.

**Isn't:**

- A `POST /history` ingestion endpoint. ADR-0017 §8 keeps history off the wire contract entirely; the "cat … | curl --data-binary @-" round-trip phrasing in the brief is a _byte-equivalence_ assertion, not a contract for accepting third-party history bytes. Web exports; web does not ingest.
- A schema change. The Zod mirror at `apps/api/src/domain/history-record.ts` is byte-locked against ADR-0017 §2 and stays untouched.
- A change to `docs/api-contract.md`. The history egress endpoint is operator-only by ADR-0017 §8 and was never on the wire surface.
- A new test framework / harness. The spec uses the existing vitest setup, the existing `InMemoryHistoryStore`, and the existing `ExportHistory` use case — no Docker, no toolchain hop, no fixtures-as-code generator.
- Coverage of pre-`v: 1` records or `v: 2` records. Per ADR-0017 §6 the writer guarantees `v: 1` and the reader drops anything else; both directions are already tested in `history-record.spec.ts`. The fixture stays on `v: 1` exclusively.
- A behavioural change in the production write path. The interceptor + `RecordHistory` + `InMemoryHistoryStore` stay as they are; this is purely a fixture commit + spec.

## Snapshot pointer

- **Mirroring from:** ADR-0017 §2 / §6 / §8 at `dbboard@62ed834:docs/decisions.md`; reference implementation at `dbboard@72cb165:crates/dbboard-ui/src/history.rs`; desktop Stage 2 closeout at `dbboard@ae86627`. Desktop tip at the time of opening this issue is `dbboard@409fa54` (PR #26 merged).
- **Local web state:** `develop @ e33e2bc` (three commits ahead of `origin/develop @ ee94534` — the 0017 schema-browser slice landed yesterday, push pending).
- **Why now:** Phase 5 frontend is done (slice 1 history sidebar + slice 2 schema browser both on `develop`). The only Phase 5 acceptance line still not ticked is the cross-implementation byte equivalence; closing it lets the maintainer file the Phase 5 closeout brief back to desktop.

## Why a desktop-sourced fixture (and not synthesised)

The web schema and the desktop schema are both ADR-0017 §2 verbatim. A synthesised fixture would pass the same assertions because both sides are reading from the same spec — that's a tautology, not a cross-check. The valuable property is **byte equivalence between two independent implementations** of the same schema:

- Desktop writes via `serde_json::to_string(&RecordWire)` (Rust serde, declaration-order fields, no whitespace).
- Web writes via `JSON.stringify(record)` (V8 JSON.stringify, insertion-order fields, no whitespace).

If the two ever diverge on canonical bytes (e.g., one side starts sorting keys, the other introduces a custom serializer, an `Option<T>` mapping changes between `null` and field-omission), the divergence is a cross-repo ADR-level event. Catching that divergence requires bytes from _desktop's actual serialiser_, not bytes we hand-craft on the web side. The fixture commit captures one direction of that contract; the byte-equivalence assertion in `desktop-history-roundtrip.spec.ts` is what would alarm if either side drifts.

## Tasks

- [x] Receive the maintainer's go-ahead for the "issue + ADR + scaffold + handoff brief today" path (option A, 2026-06-23).
- [ ] Open this issue (`0018`).
- [ ] Draft the handoff brief at [`../handoff/2026-06-23-history-fixture-emit-outgoing.md`](../handoff/2026-06-23-history-fixture-emit-outgoing.md) specifying:
  - The set of records the fixture needs to cover (success-with-rows, success-with-rows-affected, success-with-no-result, error envelope per `CategorizedError` category, unknown-field forward-compat).
  - The delivery convention (one line per record, LF terminator, no trailing blank line, no whitespace inside the JSON — exactly what `serde_json::to_string` produces).
  - The desktop helper shape (small `cargo run --example emit-history-fixture` or `cargo test --test fixture_emit -- --include-ignored` that prints to stdout; the maintainer pipes stdout into a file and ships it).
  - Anchors: ADR-0017 §2 / §6 / §8, `RecordWire` declaration order, the ts format invariant, the `rows` vs `rows_affected` mutual exclusion.
- [ ] Add the ADR entry in `.claude/decisions.md` for fixture provenance + drift policy.
- [ ] Land the skipped scaffold:
  - `apps/api/test/desktop-history-roundtrip.spec.ts` as `describe.skip(...)` so vitest stays green until the fixture lands.
  - `apps/api/test/fixtures/README.md` documenting the slot and the drop-in recipe.
  - `apps/api/test/fixtures/.gitignore` to keep `local-history.jsonl` out of version control.
- [ ] Update [`project-status.md`](../project-status.md) with a "Phase 5 closeout (`0018`) — scaffold + handoff in progress, fixture awaited" paragraph.
- [ ] Update [`roadmap.md`](../roadmap.md) — refine the "round-trip cross-check against an actual desktop fixture still pending" line to point at this issue.
- [ ] Two commits to `develop`: (1) docs (issue + handoff + ADR + status + roadmap), (2) scaffold (skipped spec + fixtures README + .gitignore). AI-authored; never `git push`.
- [ ] **(fixture-arrival step, not in this scaffold pass)** Once the desktop agent delivers `desktop-history.jsonl`:
  - Drop the file at `apps/api/test/fixtures/desktop-history.jsonl`.
  - Flip `describe.skip` → `describe`.
  - Run the full verification chain; expect all assertions to pass.
  - Update the issue status to closed, this ticket's tasks ticked, and add the closeout entry to `project-status.md` + `roadmap.md`.

## Definition of Done

- [ ] `apps/api/test/fixtures/desktop-history.jsonl` exists and contains bytes produced by desktop's `RecordWire` serialiser, covering at minimum: one success-with-rows record, one success-with-rows-affected record, one success-with-both-null record, one error record per `CategorizedError` category (`query` / `connection` / `schema` / `type_conversion` / `capability`), and one forward-compat record carrying an unknown field.
- [ ] `apps/api/test/desktop-history-roundtrip.spec.ts` runs against the fixture and asserts:
  1. Per-line canonical-form invariant `JSON.stringify(JSON.parse(line)) === line.trimEnd()` for every non-forward-compat line.
  2. `historyRecordSchema.safeParse(parsed).success === true` for every line (forward-compat lines included — Zod strips unknown fields silently per the brief's §"Forward-compat policy").
  3. Round-trip through `InMemoryHistoryStore.record(parsed)` + `ExportHistory.stream()` produces a line byte-identical to the original _except_ for fixture lines carrying unknown fields, where the unknown field is dropped on re-emit (the spec asserts the strip explicitly).
- [ ] Forward-compat assertion: the unknown-field fixture line is accepted by the schema, the unknown field is dropped on re-emit, no error is raised.
- [ ] ADR entry in `.claude/decisions.md` is in place and cross-references desktop ADR-0017 by anchor (`dbboard@62ed834:docs/decisions.md`).
- [ ] `pnpm format:check`, `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build` all green.
- [ ] `project-status.md` + `roadmap.md` point at the closed `0018` issue, with the Phase 5 acceptance line ticked.

## Disposition

- This issue lands a docs + scaffold pair (two commits) today. The fixture itself is awaited from the desktop agent and arrives as a separate maintainer-driven drop-in.
- The scaffold's `describe.skip` keeps `pnpm -r test` green and the slice trivially landable. When the fixture arrives, removing the `.skip` and running the chain is the closeout step.
- The desktop helper (fixture-emit binary / test) is **desktop's** to author and own; web does not edit desktop code. The handoff brief is the contract.
- No HTTP contract change. No production code change. Schema unchanged. Egress path unchanged.

## References

- Desktop ADR-0017: `dbboard@62ed834:docs/decisions.md` (search `## ADR-0017`).
- Desktop reference implementation: `dbboard@72cb165:crates/dbboard-ui/src/history.rs`; current tip at issue open is `dbboard@409fa54`.
- Desktop Stage 2 closeout: `dbboard@ae86627`.
- Cross-repo brief (incoming, 2026-06-04): [`../handoff/2026-06-04-history-schema-mirror-incoming.md`](../handoff/2026-06-04-history-schema-mirror-incoming.md).
- Desktop-facing brief (outgoing, 2026-06-23): [`../handoff/2026-06-23-history-fixture-emit-outgoing.md`](../handoff/2026-06-23-history-fixture-emit-outgoing.md).
- Web ADR for the schema mirror: `.claude/decisions.md` "2026-06-05 — Query-history persistence mirrors desktop ADR-0017 (web Stage 2)".
- Web ADR for fixture provenance: `.claude/decisions.md` "2026-06-23 — Desktop `history.jsonl` fixture provenance + drift policy".
- Related web issues: [`0009`](./0009-web-history-schema-mirror.md), [`0015`](./0015-frontend-history-sidebar.md), [`0017`](./0017-frontend-schema-browser.md).
