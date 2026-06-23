# `apps/api/test/fixtures/`

Test fixtures shared across the API test suite. **Only `desktop-history.jsonl` is committed**; everything else is gitignored (see `.gitignore` next to this file).

## `desktop-history.jsonl` (committed; pending delivery as of 2026-06-23)

Byte-for-byte capture of `history.jsonl` lines produced by desktop's `RecordWire` serialiser (reference impl `dbboard@72cb165:crates/dbboard-ui/src/history.rs`; current tip `dbboard@409fa54`). Used by `apps/api/test/desktop-history-roundtrip.spec.ts` to prove the cross-implementation byte round-trip for the query-history schema (ADR-0017 §2).

**Why a committed binary-ish fixture.** Web's `historyRecordSchema` is ADR-0017 §2 verbatim. A synthesised fixture would validate against its own schema (tautology). Catching a future drift between desktop's `serde_json::to_string(&RecordWire)` and web's `JSON.stringify(record)` requires bytes from a different process — see the ADR entry "2026-06-23 — Desktop `history.jsonl` fixture provenance + drift policy" in `.claude/decisions.md`.

**Where the bytes come from.** The desktop agent owns the fixture-emit helper. Web does not edit `dbboard`. Cross-repo coordination goes through the maintainer; the outgoing brief is at `.claude/handoff/2026-06-23-history-fixture-emit-outgoing.md`.

**When to regenerate.** Only when ADR-0017 §2 itself changes, which by policy happens at the ADR cadence, not the release cadence. A regeneration is a cross-repo coordination event (drift policy in the ADR).

**Format invariants** (checked by the spec; please honour exactly):

- LF terminators (no CRLF).
- Trailing `\n` after the last record.
- No whitespace inside the JSON.
- Field order as declared in `RecordWire`: `v, ts, conn, actor, sql, status, duration_ms, rows, rows_affected, error`.
- `null` rather than field omission for `Option<T>` fields (`actor`, `rows`, `rows_affected`, `error`).
- At least one forward-compat record carrying an unknown top-level field per the brief's case 5.

**Spec behaviour without the file.** `apps/api/test/desktop-history-roundtrip.spec.ts` uses `describe.skipIf(!existsSync(...))`, so the suite is silently inert until the file lands. `pnpm -r test` stays green either way.

## `local-history.jsonl` (gitignored; opt-in)

Ad-hoc slot for the maintainer to drop a real interactively-generated `history.jsonl` from a desktop run for one-off cross-checking — typically extracted from:

- Windows: `%APPDATA%\dbboard\dbboard\config\history.jsonl`
- macOS: `~/Library/Application Support/dev.dbboard.dbboard/history.jsonl`
- Linux: `$XDG_CONFIG_HOME/dbboard/history.jsonl` (default `~/.config/dbboard/history.jsonl`)

(Paths derive from `directories::ProjectDirs::from("dev", "dbboard", "dbboard")` in `dbboard@:crates/dbboard-config/src/store.rs`.)

The spec picks up the file iff **both**:

- the file is present at `apps/api/test/fixtures/local-history.jsonl`, and
- `DBBOARD_LOCAL_HISTORY_FIXTURE=1` is set in the environment.

Both gates are intentional — a forgotten file from a prior session shouldn't silently affect a different test run. Run locally with:

```sh
DBBOARD_LOCAL_HISTORY_FIXTURE=1 pnpm --filter @dbboard-web/api test
```

Do not commit the local file. It may contain SQL bodies from real connections.
