# 0023 — History schema v:1 → v:2 (mirror desktop ADR-0027 / brief 0008)

**Status:** done (2026-08-04) · **Opened:** 2026-08-04 · **Rung 1** of
[`../parity-ledger.md`](../parity-ledger.md)

One item stays open and is not web's to close: the desktop fixture covers
`kind: "ai"` only at `status: "ok"`. See § "Owed by desktop".

## Purpose

Bump the per-record history JSON contract from v:1 to v:2, adding a top-level
`kind` discriminator so AI calls can be recorded alongside SQL calls. The
schema is the cross-repo contract (ADR-0004); this ticket mirrors it, it does
not design it. The design lives in desktop ADR-0027 and is cited by anchor
rather than copied — see
[`../handoff/2026-08-04-history-v2-mirror-incoming.md`](../handoff/2026-08-04-history-v2-mirror-incoming.md).

This also lifts the hard redline recorded in Phase 6: "do not record AI calls
in `history.jsonl` — that would force a v:1 → v:2 schema bump ahead of
cross-repo coordination." The coordination happened on 2026-06-30. The redline
was correct while it stood and is now spent.

## The one design decision this ticket has to make

Brief 0008 requires **v:1 records to load as the equivalent v:2 `kind: "query"`
record** (Acceptance §2). This repo also has a test — from ticket
[`0018`](./0018-history-export-roundtrip-fixture.md) — asserting that a
desktop-emitted v:1 fixture re-exports **byte-identically** through
`ExportHistory.stream()`.

Both cannot hold. If a v:1 record becomes a v:2 record on read, re-emitting it
produces v:2 bytes.

**Decision: upgrade on read.** The brief wins, and the byte-identity assertion
narrows to "v:1 in, canonical v:2 out."

The reason this is safe here specifically: web's history store is in-memory, so
**there is no v:1 data in this system to preserve**. Nothing persists across a
restart. The v:1 read path exists solely to ingest desktop-emitted files, and
for that purpose "read it and represent it correctly" is the requirement —
round-tripping it back to disk unchanged is not something any caller does.

That would be a different judgement in a repo with a persisted v:1 corpus, and
the ADR should say so, because the next schema bump will face the same fork
with a store that by then may not be in-memory.

## Scope

**In:**

- `apps/api/src/domain/history-record.ts` — Zod discriminated union on `kind`;
  the v:1 shape kept as a read-only legacy schema that upgrades.
- `apps/api/src/usecase/parse-history-ndjson.ts` — accept v:2; new counter
  buckets for unknown `kind` and unknown `intent`; keep unknown-`v` for v≥3.
- `apps/api/src/usecase/record-history.use-case.ts` — write `v: 2`,
  `kind: "query"`; add an AI recording path.
- ~~`apps/api/src/presentation/ai.controller.ts` — record AI completions.~~
  **No-op as scoped.** Recording landed in the use cases
  (`explain-sql` / `suggest-sql`, via the shared `record-ai-call.ts` body), not
  the controller. The controller has neither the timing boundary nor the
  `AiError` taxonomy, and the existing `HistoryRecordingInterceptor` cannot be
  reused because it reads `req.body.sql` and maps a `QueryResult` — an AI call
  has neither. The controller did change, but for an unrelated reason: it now
  projects the widened `AiResponse` down to the documented `{ text, model }`
  wire body.
- Conformance + round-trip specs; a v:2 fixture.

**Out:** `GET /ai-history` (history stays off the wire), v:3, cross-tenant
admin views, and any new `intent` or `error.category` value.

## The invariants worth stating before writing code

Each of these is a place where a plausible implementation is wrong:

1. `status: "cancelled"` carries `error: null`. Cancel is not a failure. The
   partial response accumulated before the cancel goes in `response`.
2. AI `error.category` is `"network" | "provider" | "configuration"`. It is a
   **different enum** from the query-record category, which stays at the five
   DB categories. `cancelled` appears in neither — it is a status.
3. `prompt` and `response` are verbatim **in content**. No redaction, no
   normalisation. Access control is a separate web-side concern; solving it in
   the schema would break the contract.
4. `prompt` and `response` are **not** verbatim in length. ADR-0027
   Decision 10 caps each at 64 KiB **at the writer**, truncating at a UTF-8
   code-point boundary at-or-below the cap and appending
   `" [truncated at 64 KiB]"`. Missed on the first pass of this ticket — the
   original invariant 3 read "no trimming", which was wrong. Found by reading
   `AiRecordWire::from_entry`, which calls `truncate_for_persistence` on both
   fields.

   Two traps here, both live:
   - The cap counts **UTF-8 bytes**; JS string length is UTF-16 code units.
     For CJK text a naive `slice(0, CAP)` keeps ~3x too much.
   - The ADR prose renders the marker as `… [truncated at 64 KiB]` with a
     leading ellipsis; the shipped constant has a leading **space** and no
     ellipsis. Bytes must match, so the implementation is the authority.

   The reader stays permissive (bare `z.string()`, no `.max()`), matching
   desktop, so a record written under a different cap is still readable.

5. Unknown top-level fields are ignored, not rejected. Unknown `v` / `kind` /
   `status` / `intent` are dropped whole, never parsed partially.

## Acceptance

- [x] Writes are byte-compatible with ADR-0027: same field names, types,
      `v: 2`, `kind`, `status`, `intent`, and error-envelope nesting.
      Confirmed empirically — the desktop-emitted v:2 fixture re-exports
      **byte-identically** through `ExportHistory.stream()`, AI record
      included.
- [x] A v:1 record loads as the equivalent v:2 `kind: "query"` record.
- [x] An AI record with `status: "cancelled"` has `error: null`, and the
      schema **rejects** one that does not.
- [x] Unknown `v` / `kind` / `status` / `intent` drop with an observable
      per-reason counter; unknown top-level fields are tolerated.
- [x] Export streams v:2 NDJSON; `jq -c .` round-trip is a no-op.
- [x] Writer caps `prompt` / `response` per Decision 10 (added after the
      invariant-4 correction above).
- [x] A web ADR cites desktop ADR-0027 by anchor (file + date), and records
      the upgrade-on-read fork above with its reasoning.
- [x] The Phase 6 redline in `roadmap.md` is marked spent rather than deleted,
      so the reason it existed stays legible.

## Owed by desktop

A desktop-emitted v:2 fixture at
`apps/api/test/fixtures/desktop-history-v2.jsonl`, covering at minimum: a
`kind: "query"` record, a `kind: "ai"` `status: "ok"` record, a `kind: "ai"`
`status: "error"` record, and a `kind: "ai"` `status: "cancelled"` record.

**Partially delivered, 2026-08-04.** Generated locally from the desktop
emitter — `cargo run --example emit_history_fixture -p dbboard-ui -- --output
<path>`, the command brief 0008 § Handoff step 3 prescribes — so the bytes are
genuinely desktop's serialiser, not a web-authored guess. 11 lines: all eight
query cases, the forward-compat record, an actor record, and one
`kind: "ai"` record.

**Still owed: the AI error and cancelled records.** The emitter has exactly one
`AiStatus::Ok` construction (`emit_history_fixture.rs:197`) and no others.
`cancelled` is the gap that matters most, because web never _writes_ that
status — there is no abort path on a non-streaming request/response surface —
so its read support is exercised only against web-authored objects. That is
precisely the circular validation a desktop fixture exists to break. Raised
back to desktop per brief 0008 § Notes rather than papered over — outgoing
brief at
[`../handoff/2026-08-04-ai-fixture-cases-outgoing.md`](../handoff/2026-08-04-ai-fixture-cases-outgoing.md).

The v:1 fixture stays at its existing path as the back-compat evidence.

## Verification

```sh
pnpm format:check && pnpm -r lint && pnpm -r typecheck && pnpm -r test
```

## Log

- **2026-08-04** — opened. Receipt written 35 days after the brief; found by
  the parity survey, not by the handoff.
- **2026-08-04** — schema, reader, writer and specs landed. Two things worth
  carrying forward:

  **The Decision 10 cap was missed on the first pass.** Invariant 3 originally
  read "no trimming", copied from the ADR's Decision 8 summary, which is about
  redaction. The cap lives in Decision 10 and only becomes visible in
  `AiRecordWire::from_entry`. It surfaced by accident: I was about to name
  desktop's type in a code comment and checked the name against the source
  (§19) rather than asserting it. **The generalisable part is that the gap was
  invisible from the ADR summary and visible only in the reference
  implementation** — for the remaining parity rungs, read the shipped code, not
  the decision record's prose.

  **Byte-identity is now empirically established, not argued.** Before the
  fixture landed, key-order equivalence rested on reasoning about Zod v4
  normalising to schema-declaration order on parse. The desktop-emitted v:2
  fixture now re-exports byte-for-byte, AI record included, so that reasoning
  is confirmed rather than assumed.

  Verified in the api workspace: typecheck exit 0; `vitest run` → 49 files,
  403 passed / 2 skipped. Docker was up, so the 23 postgres-integration tests
  genuinely ran rather than skipping.
