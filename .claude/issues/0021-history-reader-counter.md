# 0021 — History reader with unknown-`v`/`status` counter (Phase 5 DoD closeout)

- **Status:** in progress
- **Phase:** web-side Phase 5 reader forward-compat (closes the last unticked bullet in [`../roadmap.md`](../roadmap.md) § "Phase 5 — Schema browser & query history")
- **Opened:** 2026-06-25
- **Branch:** none (direct-to-`develop`, per the Phase 4/5/6 slice pattern)
- **Depends on:** [`0009`](./0009-web-history-schema-mirror.md) (per-record schema), [`0018`](./0018-history-export-roundtrip-fixture.md) (forward-compat fixture).
- **Anchors:**
  - Desktop ADR-0017 §6 (forward-compat policy).
  - Web `apps/api/src/domain/history-record.ts` — top-of-file forward-compat note already documents the intended caller behaviour ("Records with `v` other than 1 or unknown `status` fail safeParse so the caller drops them and ticks an observable counter"); this ticket lands the caller.

## Goal

Add a pure NDJSON reader that:

1. Accepts well-formed records that match `historyRecordSchema` (Zod default strip handles unknown fields).
2. Drops records with `v !== 1` or unknown `status`, attributing each drop to the right typed counter so an operator can see _why_ records went missing — not just _that_ they did.
3. Drops malformed JSON and schema-failing records under their own counters so the three classes of drop are distinguishable.

Returns `{ records, stats }` — `stats` is the observable counter required by the Phase 5 DoD bullet:

> Reader tolerates unknown fields and drops records with unknown `v` / `status` **with an observable counter**.

No HTTP surface, no DI wiring, no consumer yet — the natural callers are a future ingest endpoint, a CLI re-import script, or a `pnpm conformance` extension that reads `apps/api/test/fixtures/desktop-history.jsonl` through the reader instead of the spec-only Zod path. Shipping the reader now means those callers don't have to re-derive the counter taxonomy.

## What this is — and what it isn't

**Is:**

- A new `apps/api/src/usecase/parse-history-ndjson.ts` exporting:
  - `HistoryReaderStats` — `{ accepted, dropped_invalid_json, dropped_unknown_v, dropped_unknown_status, dropped_invalid_shape }`, all `number`.
  - `HistoryReaderResult` — `{ records: HistoryRecord[]; stats: HistoryReaderStats }`.
  - `parseHistoryNdjson(bytes: string): HistoryReaderResult` — splits on LF, drops the trailing empty element (LF-terminated files), iterates each line.
- Pre-schema attribution: before handing a line to `historyRecordSchema.safeParse`, the reader peeks at `v` and `status` so it can route drops to the right counter. Zod alone would conflate every miss into "shape didn't match"; the DoD explicitly distinguishes unknown-`v` / unknown-`status` from generic invalid-shape.
- A `parse-history-ndjson.spec.ts` covering: accept of a valid record, accept of a forward-compat record with an unknown field, drop of `v: 2`, drop of `status: "weird"`, drop of malformed JSON, drop of schema-failing JSON (e.g., wrong types), counter aggregation across a mixed batch, and the LF-trailing-newline convention.
- A Phase 5 roadmap tick on the last unchecked DoD bullet, plus a `project-status.md` entry recording the closeout.

**Isn't:**

- Not an HTTP route. `docs/api-contract.md` stays unchanged — there is no `POST /history/import` on the wire (ADR-0017 §8 keeps history off the wire).
- Not a DI-bound service. No consumers in this slice; future callers can `import { parseHistoryNdjson }` directly as a pure function.
- Not a logger or metrics emitter. The counter is a typed return value; callers choose whether to log it, expose it on a metrics endpoint, or assert on it in tests.
- Not a change to `historyRecordSchema` or `ExportHistory`. The egress path stays the trusted writer's path — no validation gating, no counter bump there.
- Not a desktop-side concern. Desktop has its own reader; the cross-repo contract is the per-record JSON shape, not the reader implementation.

## TDD plan

1. **Red** — `apps/api/src/usecase/parse-history-ndjson.spec.ts`:
   - `parseHistoryNdjson("")` returns empty records, all-zero stats.
   - A single valid line is accepted; `stats.accepted === 1`, all other counters `0`.
   - A line with an unknown extra field (`unknown_field: "x"`) is accepted; the field is stripped from the returned record.
   - A `v: 2` line is dropped; `stats.dropped_unknown_v === 1`, `records.length === 0`.
   - A line with `status: "weird"` is dropped; `stats.dropped_unknown_status === 1`.
   - A malformed JSON line (`"{not json"`) is dropped; `stats.dropped_invalid_json === 1`.
   - A schema-failing line (missing required field) is dropped; `stats.dropped_invalid_shape === 1`.
   - A mixed batch aggregates each counter independently and preserves accepted-record order.
   - Trailing LF is tolerated (the empty final element is not counted as `dropped_invalid_json`).
2. **Green** — `apps/api/src/usecase/parse-history-ndjson.ts`:
   - Split on LF, pop trailing empty if present.
   - For each line, attempt `JSON.parse` → catch into `dropped_invalid_json`.
   - Pre-check `v` and `status` against the literal/enum surface before Zod (typed peek; if either is present and out of the allowed set, attribute the drop and continue).
   - Otherwise `historyRecordSchema.safeParse` → success accumulates into `records` + `accepted`; failure into `dropped_invalid_shape`.
3. **Refactor** — keep the function shape pure (no async, no I/O); accept `string`, return the result object.

## Verification

- `pnpm format:check`
- `pnpm --filter @dbboard-web/api typecheck`
- `pnpm --filter @dbboard-web/api lint`
- `pnpm --filter @dbboard-web/api test`
- `pnpm -r build`

API test count should go from `313 + 2 skipped` to `313 + N + 2 skipped` where `N` is the new spec count (~9).

## DoD

- [ ] `parseHistoryNdjson` exported from `apps/api/src/usecase/parse-history-ndjson.ts`.
- [ ] `HistoryReaderStats` distinguishes `dropped_unknown_v` and `dropped_unknown_status` from `dropped_invalid_shape` and `dropped_invalid_json`.
- [ ] Unit spec covers each counter independently plus a mixed-batch aggregation.
- [ ] Roadmap Phase 5 DoD line "Reader tolerates unknown fields and drops records with unknown `v` / `status` with an observable counter." ticked.
- [ ] `project-status.md` records the slice closeout.
- [ ] Full verification chain green; no HTTP contract change; no change to `historyRecordSchema` / `ExportHistory` / `InMemoryHistoryStore`.
