# Handoff: desktop fixture-emit helper for `history.jsonl` round-trip — outgoing brief (2026-06-23)

Outgoing brief from `dbboard-web` to the desktop (`dbboard`) agent. Companion to web issue [`0018`](../issues/0018-history-export-roundtrip-fixture.md) and the [fixture-provenance ADR](../decisions.md) (entry "2026-06-23 — Desktop `history.jsonl` fixture provenance + drift policy").

The maintainer will hand this brief to the desktop agent directly — please do not edit `dbboard` from the web side; cross-repo coordination goes through the maintainer.

## TL;DR

Web's Phase 5 closeout (`0018`) needs **a small set of `history.jsonl` lines emitted by desktop's actual `RecordWire` serialiser** so the web side can assert byte equivalence of the cross-implementation round-trip:

```
desktop bytes  ──parse──▶  historyRecordSchema  ──InMemoryHistoryStore──▶  ExportHistory.stream()  ──▶  identical bytes
```

The deliverable is **one text file** of ~6–10 lines, produced by a desktop helper (test, example, or hidden bin) that calls the existing `RecordWire::from_entry` + `serde_json::to_string` path. Web commits the file at `apps/api/test/fixtures/desktop-history.jsonl` and flips a `describe.skip` to live.

## Why we need it (not synthesised on the web side)

Both repos mirror ADR-0017 §2 verbatim, so a web-synthesised fixture would tautologically validate against the web schema. The whole point of the cross-check is to compare the bytes coming out of two independent implementations of the same spec:

- **Desktop write path:** `serde_json::to_string(&RecordWire)` at `crates/dbboard-ui/src/history.rs` (`72cb165` reference, `409fa54` current tip). Rust serde, declaration-order fields, no whitespace, `Option<T>` mapped via `#[serde(default)]`.
- **Web write path:** `JSON.stringify(record)` invoked from `apps/api/src/usecase/export-history.use-case.ts`. V8 `JSON.stringify`, insertion-order fields (which match the Zod schema declaration order at `apps/api/src/domain/history-record.ts`).

If the two ever diverge on canonical bytes (key reorder, `Option<T>` → field omission vs. `null`, whitespace, number-formatting), that divergence is an ADR-level event — not a unilateral patch on either side. The fixture is the smoke alarm.

## What to deliver

A single text file's worth of bytes, written by desktop's production serialiser, covering the cases below. Conceptually one line per case:

### Cases (at minimum)

1. **`status="ok"` with `rows`**: a SELECT-shaped success. `rows` is a non-negative integer, `rows_affected` is `null`, `error` is `null`. Example shape — shown here on one line because the actual fixture line must be unwhitespaced; please regenerate with the real `RecordWire`, do not hand-craft:
   ```text
   {"v":1,"ts":"2026-06-23T10:00:00.000Z","conn":"prod-pg","actor":null,"sql":"SELECT 1","status":"ok","duration_ms":42,"rows":1,"rows_affected":null,"error":null}
   ```
2. **`status="ok"` with `rows_affected`**: a DML-shaped success. `rows` is `null`, `rows_affected` is a non-negative integer. The mutual exclusion is enforced by web's `superRefine`; please make sure desktop emits exactly one of the two as non-null in this line.
3. **`status="ok"` with both `null`**: legitimate per ADR-0017 §2 ("at least one is null, both may be null for no-result statements like `EXPLAIN`, `SET`, `BEGIN`"). One line covering this case.
4. **`status="error"` per category**: one line per `CategorizedError` category in ADR-0017 §2:
   - `query`
   - `connection`
   - `schema`
   - `type_conversion`
   - `capability`
     For each, `error` is `{"category":"...","message":"..."}` and `rows` / `rows_affected` are both `null`. (Per ADR-0017 §2 the error envelope nests under `error`, never beside `status`.)
5. **Forward-compat record** (one line): include a record carrying an unknown top-level field — for example `"unknown_field":"value-from-the-future"` alongside the standard ADR-0017 §2 fields — emitted as-is by `serde_json::to_string`. (Easiest way: a tiny wrapper struct or a `serde_json::Value` patched onto a `RecordWire` after serialisation, before writing the line.) Web's Zod schema will silently strip this field on re-emit per ADR-0017 §6.

### Optional but valued

6. **`actor` populated**: at least one of the `ok` lines should carry a non-null `actor` string (e.g. `"alice@example.com"`) so web verifies it round-trips. Desktop normally writes `null`; the helper should override this once for the fixture.
7. **A range of `duration_ms`** values (e.g. `0`, `42`, `1234`) so number-formatting edge cases are exercised.

The fixture is for byte-equivalence testing, not load testing — please keep it well under 100 lines total.

## Output conventions (please honour exactly)

- One JSON object per line, terminated with `\n` (LF, **not** CRLF).
- The file ends with a trailing `\n` after the last record (matches desktop's `writeln!` behaviour and what `cat ... | curl --data-binary @-` produces).
- No whitespace inside the JSON object (the `serde_json::to_string` default — please do **not** use `to_string_pretty`).
- No BOM, no trailing blank line, no leading blank line.
- Field order **as declared in the `RecordWire` struct**: `v, ts, conn, actor, sql, status, duration_ms, rows, rows_affected, error`. (`serde_json::to_string` honours declaration order; please don't introduce `#[serde(...)]` reordering attributes for this fixture.)
- `actor`, `rows`, `rows_affected`, and `error` are `null` (not omitted) when not applicable — i.e. please write them as `Option<T>` mapped to `null` via the existing `#[serde(default)]` round-trip, not via `#[serde(skip_serializing_if)]`. Web depends on the presence of the keys for the byte equivalence check.

If any of these conventions are inconvenient or have changed since `72cb165` / `409fa54`, please flag back **before** writing the fixture so we can decide together whether to evolve ADR-0017 §2 first.

## Suggested implementation shape (desktop's call)

Three options, in order of preference — pick whichever fits the desktop test layout best:

1. **`cargo run --example emit_history_fixture` printing to stdout.** Cleanest separation, fixture generation is reproducible, no test side-effect. Maintainer pipes stdout into a file and ships it to web.
2. **`cargo test --test fixture_emit -- --include-ignored` that writes to `target/fixtures/desktop-history.jsonl`.** Lives next to the existing tests, no new bin, can be re-run on CI to re-verify if needed.
3. **One-shot script in `scripts/`** that links to `crates/dbboard-ui` and calls the same code path. Most flexible but most boilerplate.

Whichever shape is chosen, please make sure the helper goes through `RecordWire::from_entry` (or whatever the production path becomes) — not a hand-rolled `serde_json::json!(...)` — so the fixture genuinely exercises desktop's serialiser.

The forward-compat line (case 5) is the only one that may need a small wrapper, since `RecordWire` doesn't carry unknown fields by definition. Suggested approach: build a `serde_json::Value::Object` by serialising a `RecordWire` and then inserting one extra key, then `serde_json::to_string` that. Document the divergence inline in the helper so a future reader doesn't think it's a bug.

## Delivery

- **Where**: ship the file as plain text. Email / paste-into-chat / commit to a shared scratch repo — whichever is easiest for the maintainer. The web side commits it verbatim at `apps/api/test/fixtures/desktop-history.jsonl`.
- **When**: no rush. Web's `describe.skip` keeps the slice landable today; the round-trip assertions go live the day the fixture arrives. Ideally before Phase 6 begins.
- **What desktop must NOT do**: do not touch `dbboard-web`. Do not generate the fixture via a web-side script. Do not commit the fixture into `dbboard` either — it's a test artefact for `dbboard-web` only.

## Anchors

- Desktop ADR-0017: `dbboard@62ed834:docs/decisions.md` (search `## ADR-0017`).
- Desktop reference implementation: `dbboard@72cb165:crates/dbboard-ui/src/history.rs` (`RecordWire` declaration around line 210). Current tip: `dbboard@409fa54`.
- Desktop Stage 2 closeout: `dbboard@ae86627`.
- Web schema mirror: `dbboard-web@f8154c3:apps/api/src/domain/history-record.ts`.
- Web export endpoint: `dbboard-web@e33e2bc:apps/api/src/presentation/history.controller.ts` + `apps/api/src/usecase/export-history.use-case.ts`.
- Web issue tracking this slice: [`0018`](../issues/0018-history-export-roundtrip-fixture.md).
- Web fixture-provenance ADR: [`../decisions.md`](../decisions.md) — entry "2026-06-23 — Desktop `history.jsonl` fixture provenance + drift policy".
- Original incoming brief (the contract this round-trip enforces): [`2026-06-04-history-schema-mirror-incoming.md`](./2026-06-04-history-schema-mirror-incoming.md).
