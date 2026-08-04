# Handoff: two more AI cases in the v:2 fixture emitter — outgoing brief (2026-08-04)

Outgoing brief from `dbboard-web` to the desktop (`dbboard`) agent. Companion to web ticket [`0023`](../issues/0023-history-v2-mirror.md) § "Owed by desktop" and the ADR at [`../decisions.md`](../decisions.md) (entry "2026-08-04 — History schema v:2: mirror desktop ADR-0027, and upgrade v:1 on read", § Known gap).

The maintainer will hand this brief to the desktop agent directly — please do not edit `dbboard-web` from the desktop side; cross-repo coordination goes through the maintainer.

Filed under brief 0008 § Notes: "If web discovers an ambiguity or a gap, file it back as a desktop-side ticket rather than diverging silently."

## TL;DR

`crates/dbboard-ui/examples/emit_history_fixture.rs` emits **one** `kind="ai"` record, `status="ok"` (`ai_explain_ok`, called from `emit_ai_cases`). Web needs two more lines from the same emitter:

- `status="error"` with a populated `error` envelope
- `status="cancelled"` with `error: null` and a **non-empty** `response`

Roughly 40 lines of Rust in a file already shaped for it — two more constructors next to `ai_explain_ok` and two more `emit_line` calls in `emit_ai_cases`.

## Why this specific gap matters

Web mirrored ADR-0026 Decision 12 (cancel is not a failure: `status="cancelled"` carries `error: null`, and the partial accumulator goes in `response`). Its schema enforces that, and there are tests.

But **web never writes a `cancelled` record.** Its AI surface is non-streaming request/response with no abort path, so a web-side cancel writer would be unreachable code — web ticket 0023 Decision 3 records that deliberately. The consequence is that web's read support for `cancelled` is exercised only against objects web itself constructed from its own reading of the ADR.

That is exactly the circular validation the desktop fixture exists to break, and it is the one case where the two implementations have no overlap to cross-check against. If web has misread Decision 12 — say, by assuming `response` is empty on cancel, or that `duration_ms` is measured to the abort rather than to the terminal event — nothing in either repo currently catches it.

The `error` case is the lower-stakes half: web does write those, so the mapping is at least exercised end to end. It is worth adding in the same pass because it is nearly free once the constructor pattern is there.

## What to deliver

The same artefact as last time: a regenerated `desktop-history-v2.jsonl`, produced by

```sh
cargo run --example emit_history_fixture -p dbboard-ui -- --output <path>
```

with `emit_ai_cases` extended. Web replaces its committed copy at `apps/api/test/fixtures/desktop-history-v2.jsonl` verbatim. Line count goes 11 → 13.

### Case A — `status="error"`

Suggested shape (please generate through `AiEntry` / `fixture::serialize`, not by hand):

- `intent`: `suggest_sql`, so the fixture covers both intent values — the existing line is `explain`.
- `response`: `""`. Nothing accumulated before the failure.
- `error`: `Some(HistoryError { category: "provider", message: ... })`.
- `tokens_in` / `tokens_out`: `None`. A failed call that reported no usage is the common case, and it is also the case web's `runRecordedAiCall` writes on the error path — the two should meet.
- `stop_reason`: `None`.
- `conn`: `None`. Web's AI routes carry no connection id, so this exercises the nullable `conn` that the query record does not have. Worth covering somewhere in the fixture, and this line is the natural place.

If desktop's AI error categories differ from `network | provider | configuration`, **please flag that back before generating** rather than emitting a fourth value — the enum is part of the shared record contract, and a new category is an ADR-level event on both sides.

### Case B — `status="cancelled"`

- `intent`: either.
- `response`: **non-empty** — a plausible partial, e.g. the first sentence of an explanation, cut off mid-word. The whole point of this line is to pin that a cancel preserves what the user paid for. A line with `response: ""` would pass web's schema while proving nothing.
- `error`: `None`. Web's `superRefine` rejects a non-null `error` on any non-`error` status, so if desktop disagrees here the fixture will fail loudly on the web side — which is the correct outcome and the reason to send the line.
- `tokens_in` / `tokens_out`: whatever desktop actually records at cancel time. If it is `Some(..)` for input and `None` for output, that is more informative than two nulls — please emit what the real path produces rather than what looks tidy.
- `stop_reason`: whatever the real path produces. Web treats it as an open string set and never branches on it.
- `duration_ms`: measured the same way the production path measures it. If desktop measures to the abort rather than to a terminal provider event, say so in the brief reply — web's `duration_ms` semantics assume the latter and that assumption should be checked rather than inherited.

## Conventions (unchanged from the 2026-06-23 brief)

LF only, trailing newline, no whitespace inside the JSON, keys in `AiRecordWire` declaration order, `null` written rather than the key omitted. Web asserts byte-identical re-emit on every known-key line, so any of these drifting shows up as a test failure rather than silently.

## What web has already verified

Worth knowing before you touch anything, so this brief does not read as "something is broken":

- All 11 existing lines parse, and every one of `HistoryReaderStats`' seven drop counters is zero.
- Every known-key line re-exports **byte-identically** through web's `ExportHistory.stream()`, the AI line included. Key order and canonical form agree across the two serialisers.
- The unknown-field line is stripped on re-emit, per ADR-0027 § Forward-compat.

So the emitter is right as far as it goes. This is a coverage ask, not a defect report.

## One thing web found that desktop may want to check

ADR-0027 Decision 10's prose renders the truncation marker with a leading ellipsis (`… [truncated at 64 KiB]`). The shipped constant in `crates/dbboard-ui/src/history.rs` has a leading **space** and no ellipsis.

Web mirrored the constant, on the grounds that the bytes have to match a running program rather than a document. Flagging it because the divergence is in desktop's own ADR and someone may eventually "fix" the code to match the prose — which would break byte-compatibility in both directions. If the prose is what was meant, that is a coordinated change, not a typo fix.

## Anchors

- Desktop emitter: `crates/dbboard-ui/examples/emit_history_fixture.rs` — `ai_explain_ok` and `emit_ai_cases`.
- Desktop reference: `crates/dbboard-ui/src/history.rs` — `AiRecordWire`, `truncate_for_persistence`.
- Desktop ADRs: ADR-0027 (Decisions 5, 8, 9, 10), ADR-0026 Decision 12.
- Original incoming brief: `dbboard/.claude/issues/0008-web-history-v2-mirror.md`; web's receipt at [`2026-08-04-history-v2-mirror-incoming.md`](./2026-08-04-history-v2-mirror-incoming.md).
- Prior fixture brief (v:1, same shape of ask): [`2026-06-23-history-fixture-emit-outgoing.md`](./2026-06-23-history-fixture-emit-outgoing.md).
- Web ticket: [`../issues/0023-history-v2-mirror.md`](../issues/0023-history-v2-mirror.md).
- Web round-trip spec: `apps/api/test/desktop-history-roundtrip.spec.ts` — the v:2 block documents this gap inline.

## Priority

Low. Web's v:2 support is landed and green without it; the two lines close a validation gap rather than unblock anything. No rush, and no need to reply beyond "queued" unless one of the two flagged items above (error-category set, marker prose) turns out to be a real divergence.
