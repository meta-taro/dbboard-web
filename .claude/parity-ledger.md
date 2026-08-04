# Desktop parity ledger

Maps every desktop ADR (`dbboard/docs/decisions.md`, ADR-0001 … ADR-0085 as of
`dbboard@2fab7ba`) onto a web-side status, so "how far behind is web?" is a
lookup rather than a re-survey.

**This ledger does not override [ADR-0004](./decisions.md).** The two repos
share the HTTP API contract and the user-data JSON formats, nothing else.
Feature parity is a _goal we chose_, not an obligation the contract imposes —
so a `n/a` row below is a correct outcome, not a gap being excused.

Status values:

| Status    | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `done`    | Web has the behaviour.                                        |
| `partial` | Some of it exists; the row says which part is missing.        |
| `todo`    | Portable and wanted. Carries a rung (see the plan below).     |
| `n/a`     | Not portable, or deliberately not mirrored. The row says why. |

---

## The three categories

**A — contract obligations.** The shared surface from ADR-0004. Drift here is a
correctness bug in a way a missing feature is not: desktop and web write the
same files and speak the same wire, so a schema either matches or silently
corrupts round-trips. One row in this category is overdue.

**B — portable features.** Desktop shipped a product behaviour that web's
surface could carry. Ordered below by value per line of change, not by ADR
number.

**C — not portable.** Rust/Tauri/packaging/OS-integration concerns, plus the
things web already decided against with a recorded rationale.

---

## Category A — contract obligations

| Desktop                | Subject                                            | Web status                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0017               | `history.jsonl` per-record schema v:1              | `done` — [`0018`](./issues/0018-history-export-roundtrip-fixture.md) round-trips a desktop-emitted fixture.                                                                                                                                                                                                                                                                                                                                                                   |
| **ADR-0027**           | **history schema v:1 → v:2, `kind` discriminator** | **`todo` (rung 1) — overdue.** Desktop brief [`0008-web-history-v2-mirror.md`](../../dbboard/.claude/issues/0008-web-history-v2-mirror.md) was written 2026-06-30 and never received here; `.claude/handoff/` has no 2026-06-30 receipt. `apps/api/src/domain/history-record.ts` still pins `v: z.literal(1)`, so desktop-emitted v:2 records are being _dropped with a counter tick_ — the forward-compat path from brief 0003 doing its job, but the records are invisible. |
| ADR-0012               | Capability flags are additive                      | `partial` (rung 0) — desktop's `Capabilities` grew four flags web's copy lacks: `has_describe_table` (ADR-0028), `has_table_ddl` (ADR-0049), `has_execute` + `has_atomic_restore` (ADR-0051). Purely additive and all-false, but the contract doc is the shared artifact and it is 16 lines behind.                                                                                                                                                                           |
| ADR-0024               | At-rest permissions on `history.jsonl`             | `todo` (rung 2) — desktop chmods the file it writes. Web writes the same file from the API process and does not.                                                                                                                                                                                                                                                                                                                                                              |
| ADR-0038               | Passphrase-encrypted connection bundle             | `todo` (rung 7) — an _interop format_, so if web ever exports connections the envelope has to match byte-for-byte. Not urgent while web has no export.                                                                                                                                                                                                                                                                                                                        |
| ADR-0055 / 0084 / 0085 | PII scan, commit-identity scan, web-flow committer | `done` — ported 2026-08-03, both entries in [`decisions.md`](./decisions.md).                                                                                                                                                                                                                                                                                                                                                                                                 |

## Category B — portable features

Rungs are defined in the plan below.

| Desktop                | Subject                                                       | Web status                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0070               | Row paths pin the simple/text wire protocol                   | `done by construction`, unpinned (rung 2). Web calls `pool.query({ text })` with no `values`, so node-postgres uses the simple protocol and returns text — the same place desktop landed after the bug. Nothing to fix; the gap is that **no test says so**, and the invariant is one convenience refactor away from being lost. |
| ADR-0081               | Statement timeout is probed, not assumed                      | `todo` (rung 2) — web's `PostgresAdapter` sends no timeout at all. A runaway query holds a pool connection until the socket dies.                                                                                                                                                                                                |
| ADR-0071               | An unreadable table degrades, doesn't fail the sweep          | `todo` (rung 2) — web's `listTables` has no per-table guard.                                                                                                                                                                                                                                                                     |
| ADR-0035               | CSV / TSV export of a result set                              | `todo` (rung 3) — nothing in `apps/web/app/` mentions CSV.                                                                                                                                                                                                                                                                       |
| ADR-0048               | Client-side multi-column sort                                 | `todo` (rung 3) — `ResultGrid.vue` has no sort.                                                                                                                                                                                                                                                                                  |
| ADR-0041               | Light / dark / auto theme, persisted                          | `todo` (rung 3) — dark mode appears only as a media query in `app.vue`.                                                                                                                                                                                                                                                          |
| ADR-0082               | Long cell values get an editor, not a keyhole                 | `todo` (rung 3).                                                                                                                                                                                                                                                                                                                 |
| ADR-0083               | Splitting sidebar, self-placing popovers                      | `todo` (rung 3).                                                                                                                                                                                                                                                                                                                 |
| ADR-0039               | Unified error display: localized + original English           | `partial` (rung 3) — web localizes errors across 11 locales, but drops the original English the user would paste into a search box.                                                                                                                                                                                              |
| ADR-0028               | `describe_table` full DDL extraction                          | `todo` (rung 4) — sets `has_describe_table`.                                                                                                                                                                                                                                                                                     |
| ADR-0072               | Generated SQL follows the connection's identifier dialect     | `todo` (rung 4) — the schema browser's identifier inserts quote naively.                                                                                                                                                                                                                                                         |
| ADR-0031               | Structure tab: inspect a table's columns                      | `partial` — `SchemaBrowser.vue` lists tables and columns; the depth ADR-0028 adds is the missing half.                                                                                                                                                                                                                           |
| ADR-0073               | Credentials entered as parts, not a hand-written DSN          | `todo` (rung 5).                                                                                                                                                                                                                                                                                                                 |
| ADR-0078 / 0079        | TLS is a form choice, defaulting to required                  | `todo` (rung 5) — **security-relevant**: silent fallback is the failure mode being designed out.                                                                                                                                                                                                                                 |
| ADR-0080               | The edit form asks what the add form asks                     | `todo` (rung 5).                                                                                                                                                                                                                                                                                                                 |
| ADR-0074               | Unsupported kinds disabled in the list, not refused on submit | `todo` (rung 5).                                                                                                                                                                                                                                                                                                                 |
| ADR-0076 / 0077        | Fetch the SSH host key; Browse buttons on paths               | `n/a` for the host key until rung 7; Browse is desktop-only (no native file dialog in a browser).                                                                                                                                                                                                                                |
| ADR-0042               | Inline cell editing — the first write-back path               | `todo` (rung 6) — web is read-only today. Largest single rung.                                                                                                                                                                                                                                                                   |
| ADR-0049 / 0050        | Local logical dump + warn threshold                           | `todo` (rung 6) — sets `has_table_ddl`.                                                                                                                                                                                                                                                                                          |
| ADR-0051               | Logical restore / import                                      | `todo` (rung 6) — sets `has_execute` + `has_atomic_restore`.                                                                                                                                                                                                                                                                     |
| ADR-0045               | Local column/table annotations                                | `todo` (rung 6).                                                                                                                                                                                                                                                                                                                 |
| ADR-0007               | Cloudflare D1 adapter                                         | `todo` (rung 7).                                                                                                                                                                                                                                                                                                                 |
| ADR-0003               | Turso / libSQL adapter                                        | `todo` (rung 7) — **[`CLAUDE.md`](../CLAUDE.md) names Turso/libSQL a target database and no adapter exists.** `static-adapter-factory.ts` knows `null` and `postgres` only.                                                                                                                                                      |
| ADR-0068               | MySQL adapter                                                 | `todo` (rung 7).                                                                                                                                                                                                                                                                                                                 |
| ADR-0018 / 0019 / 0021 | Neon / Supabase / Aurora DSQL as flavored kinds               | `partial` — all three reach web through the one `PostgresAdapter`, which is the [ADR-0010 / `0010`](./issues/0010-aurora-dsql-no-mirror.md) decision, not an omission. Flavor-specific behaviour (ADR-0061's preamble gating) is moot here because web sends no preamble.                                                        |
| ADR-0069               | SSH tunnel with mandatory host-key verification               | `todo` (rung 7) — applies to a self-hosted API process, not to the browser.                                                                                                                                                                                                                                                      |
| ADR-0025               | `ai-providers.toml` + settings UI + runtime switcher          | `todo` (rung 8).                                                                                                                                                                                                                                                                                                                 |
| ADR-0026               | AI streaming, cooperative cancel, token meter                 | `todo` (rung 8) — **depends on rung 1**: the token meter's numbers are what v:2's `tokens_in` / `tokens_out` record.                                                                                                                                                                                                             |
| ADR-0052               | OpenAI provider                                               | `todo` (rung 8).                                                                                                                                                                                                                                                                                                                 |

## Category C — not portable

| Desktop                                            | Why not                                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| ADR-0001 / 0002                                    | Rust + egui + cargo workspace. Web is Nuxt + NestJS by ADR-0004.                                                        |
| ADR-0006 / 0009                                    | Desktop embeds the HTTP backend in its binary. Web _is_ the backend.                                                    |
| ADR-0013 / 0033                                    | OS keychain. No browser equivalent; web keeps secrets server-side.                                                      |
| ADR-0030                                           | `egui_extras::TableBuilder`. `ResultGrid.vue` is the web answer to the same problem.                                    |
| ADR-0032 / 0044 / 0047 / 0067                      | Windows packaging, installers, download page, auto-update. Web deploys.                                                 |
| ADR-0034                                           | rustls native roots. Node uses the OS store already.                                                                    |
| ADR-0036 / 0037                                    | Aurora DSQL IAM token minting — closed as a no-op here by [`0010`](./issues/0010-aurora-dsql-no-mirror.md).             |
| ADR-0040 / 0043                                    | Startup update check. Web has no installed version to check.                                                            |
| ADR-0046 / 0053 / 0054                             | `dbboard-mcp` read-only MCP server. A local-process surface.                                                            |
| ADR-0056 / 0057                                    | Branded _egui_ theme. [`DESIGN.md`](../DESIGN.md) is web's counterpart.                                                 |
| ADR-0059 / 0060                                    | Tauri 2 + SvelteKit + CodeMirror 6 rewrite. Web never had the egui problem these solve.                                 |
| ADR-0062 – 0066                                    | "wiring core X to Tauri, v0.4.0 parity" — the Tauri half of features already listed under B by their originating ADR.   |
| ADR-0075                                           | The SQL editor takes documents by call, not by prop. A Svelte-store idiom; web's caret-aware splicer already solves it. |
| ADR-0005 / 0011                                    | Branching and SemVer — already shared practice, no artifact to mirror.                                                  |
| ADR-0008 / 0014 / 0015 / 0016 / 0020 / 0022 / 0023 | Superseded on the desktop side, or already `done` here (11 locales, runtime switcher, history, AI provider port).       |

---

## Plan

Ordered by _what breaks if it stays undone_, not by size. Correctness before
features; shared surfaces before local ones.

| Rung  | Scope                                                                                                                                                            | Why here                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **0** | Capability-flag mirror; record the verification commands in `CLAUDE.md`.                                                                                         | Hours. Unblocks rungs 4 and 6, which set the flags.                                                                           |
| **1** | **History v:2** (ADR-0027 / brief 0008).                                                                                                                         | The one overdue contract obligation. Every day it waits, desktop-emitted AI records land here and are dropped.                |
| **2** | Adapter correctness: pin the wire-protocol invariant (0070), probe the statement timeout (0081), degrade unreadable tables (0071), chmod `history.jsonl` (0024). | Bugs, not features. Desktop paid for three of these in production.                                                            |
| **3** | Grid and UX parity: CSV/TSV (0035), sort (0048), theme (0041), long-value editor (0082), splitting sidebar (0083), original-English errors (0039).               | Highest value per line. Each is independently shippable.                                                                      |
| **4** | Schema depth: `describe_table` DDL (0028), identifier dialect (0072).                                                                                            | Contract-visible — flips `has_describe_table`.                                                                                |
| **5** | Connection form: parts not DSN (0073), TLS as an explicit choice (0078/0079), edit=add (0080), disabled kinds (0074).                                            | Security-relevant; TLS silent fallback is the thing being removed.                                                            |
| **6** | Write paths: inline cell editing (0042), dump (0049/0050), restore (0051), annotations (0045).                                                                   | Largest and riskiest. Web is read-only until this rung; that is a real safety property to give up deliberately, not by drift. |
| **7** | Adapters: Turso/libSQL (0003), D1 (0007), MySQL (0068), SSH tunnel (0069), connection bundle (0038).                                                             | Turso is named in `CLAUDE.md` and missing, which makes this the one rung with a documentation contradiction behind it.        |
| **8** | AI stage 2: provider config + switcher (0025), streaming/cancel/token meter (0026), OpenAI (0052).                                                               | Last because rung 1 is its prerequisite and because AI is optional by CLAUDE.md rule 4.                                       |

Each rung is a normal cycle: local issue under `.claude/issues/`, failing test
first, minimal implementation, docs updated in the same commit, `git push` left
to the maintainer per baseline §6.

**Rungs 6 and 7 are not "more of the same."** Rung 6 gives web a write path it
has never had, and rung 7 adds engines whose dialects web has never parsed.
Both deserve their own decision entry before any code, not just an issue.

---

Keep this file current as rungs land — a parity ledger that lags is worse than
none, because it invites the next session to trust it instead of re-checking.
