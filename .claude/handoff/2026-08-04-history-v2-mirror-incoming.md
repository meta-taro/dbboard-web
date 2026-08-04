# Incoming: history schema v:1 → v:2 (desktop ADR-0027 / brief 0008)

**Received:** 2026-08-04. **Written:** 2026-06-30. **Late by 35 days.**

## Why this receipt is late

It is not a decision that was deferred — the brief was never picked up. Every
other desktop brief has a receipt in this directory (0001, 0002, 0003, 0006,
0007); `0008-web-history-v2-mirror.md` has none. It surfaced during the
desktop-parity survey on 2026-08-04, recorded in
[`../parity-ledger.md`](../parity-ledger.md).

Worth being precise about what the delay cost, because the answer is "less than
it looks, for a reason that was designed in." Brief 0003 required v:1 readers to
drop unknown-`v` records with a counter tick rather than parsing them partially.
That is exactly what has been happening: `parseHistoryNdjson` classifies a
desktop-emitted v:2 record as `dropped_unknown_v` and moves on. No corruption,
no crash, no silent partial read. The records are simply invisible here.

So the forward-compat path worked. What failed is the handoff, and the only
reason the failure was cheap is that brief 0003 anticipated it.

## What the brief asks for

A schema bump of the per-record JSON contract, from v:1 (SQL records only) to
v:2 (SQL records **plus** AI-call records), discriminated by a new top-level
`kind` field:

- `kind: "query"` — every v:1 field, rebadged. No field added, none removed.
- `kind: "ai"` — new. Carries `intent` (`"explain" | "suggest_sql"`), `prompt`,
  `response`, `status` (`"ok" | "error" | "cancelled"`), `duration_ms`,
  `tokens_in`, `tokens_out`, `provider`, `model`, `stop_reason`, `error`.

Reader rules: unknown top-level fields ignored; unknown `v` / `kind` / `status`
/ `intent` dropped with an observable counter; **v:1 records read transparently
as `kind: "query"`**.

Two invariants that are easy to get backwards:

- `status: "cancelled"` carries `error: null`. A cancel is not an error
  (desktop ADR-0026 Decision 12 / ADR-0027 Decision 5). The partial text
  accumulated before the cancel lives in `response`.
- AI `error.category` is `"network" | "provider" | "configuration"` only.
  `cancelled` is a **status**, not a category.

`prompt` and `response` are stored verbatim — no redaction, no normalisation.
The brief is direct about the consequence: on web this means an operator can
read every tenant's natural-language questions. That is a web-side access
control problem, not a schema problem, and changing the schema to solve it
would break the contract.

## What this repo owes back

The brief's handoff procedure asks for a desktop-emitted v:2 fixture at
`apps/api/test/fixtures/desktop-history-v2.jsonl`, alongside the existing v:1
fixture (which stays where it is — it is the back-compat evidence). Requested
in [`../issues/0023-history-v2-mirror.md`](../issues/0023-history-v2-mirror.md).

Until it arrives, the conformance tests run against a locally authored v:2
fixture. That is weaker evidence and the issue says so: a fixture we wrote
proves our reader matches our own understanding of the schema, not that it
matches desktop's emitter.

## Scope this brief explicitly does not open

`GET /ai-history` over HTTP (history stays off the wire, same as brief 0003
§8), v:3, and an admin-side cross-tenant AI usage view. A web-only AI provider
is allowed — `provider` is a free string — but a new `intent` value or a new
`error.category` is a contract change and needs a desktop ADR first.

## Cross-references

- Desktop brief: `dbboard/.claude/issues/0008-web-history-v2-mirror.md`
- Desktop ADR-0027 in `dbboard/docs/decisions.md`; landed by PR #47 (`768e009`)
- Prior receipt in this chain: [`2026-06-04-history-schema-mirror-incoming.md`](./2026-06-04-history-schema-mirror-incoming.md)
- Outgoing fixture request from the v:1 round: [`2026-06-23-history-fixture-emit-outgoing.md`](./2026-06-23-history-fixture-emit-outgoing.md)
