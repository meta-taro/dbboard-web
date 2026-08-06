# 0030 — Logical restore: running a `.sql` script web did not write

**Status:** open · **Opened:** 2026-08-06 · **Rung 6b** (second of two tickets)
of [`../parity-ledger.md`](../parity-ledger.md)

## Purpose

Close rung 6b and flip the last rung-0 capability flag, `has_atomic_restore`.

| Ticket | Subject                | Desktop         | Flag                 |
| ------ | ---------------------- | --------------- | -------------------- |
| `0029` | Logical dump — closed  | ADR-0049 / 0050 | `has_table_ddl`      |
| `0030` | Restore — **this one** | ADR-0051        | `has_atomic_restore` |

`has_execute` was flipped back in rung 6a (`e71edf0`): write-back needed
`DatabaseAdapter.execute` and the flag travels with the method.

Restore carries the inverse risk of every rung so far. Rung 6a's write-back
composes one statement the user did not type but web _did_ — every character of
it comes out of `write-back.ts`, so safety is by construction. Restore executes
statements web neither wrote nor can vouch for. The safety model therefore
cannot be "escape it correctly"; it has to be "refuse to run it against a
target where it could destroy something", which is exactly what desktop
ADR-0051 decides.

## Survey

Per baseline §19 the shipped code is the authority, not the ledger row.
Desktop is at `0ffb93f`. Read: ADR-0051 (`docs/decisions.md:6231`), ADR-0065
(`:7326`), and `crates/dbboard-core/src/restore/` — `mod.rs` (34), `split.rs`
(399), `plan.rs` (258), `run.rs` (706).

### What desktop decided

ADR-0051 scopes the feature before deciding anything: input is **any** `.sql`,
not only dbboard's own dumps (`pg_dump` and `sqlite3 .dump` must import), which
forbids a narrow parser; the safety model is **empty / new targets only** —
refuse, or demand explicit confirmation, never silently merge. Out of scope:
merge, diff, conflict resolution, cross-engine translation, partial restore.

The body is a **two-layer statement pipeline**:

- **Layer 1, `split_statements`** — lexical, dialect-agnostic, classifies
  nothing and rejects nothing. Handles `--` comments, nesting-aware `/* */`,
  `'…'` with `''` doubling, `"…"`, `` `…` ``, and `$tag$…$tag$` dollar quotes.
  Backslash escapes are honoured **only** inside Postgres `E'…'`, because
  honouring them everywhere mis-scans `'a\'` as unterminated. Unterminated
  constructs consume to EOF rather than erroring; whitespace/comment-only
  segments are dropped; a trailing statement with no `;` is still returned.
- **Layer 2, `classify_script`** — sqlparser labels each statement
  `Ddl | Data | TransactionControl | Other | Unparsed` and **downgrades on
  parse failure**. That is the deliberate inverse of ADR-0046's `read_only`
  check, which fails _closed_: an unrecognised statement in a restore still
  runs verbatim and surfaces as an `unparsed_count` warning, because refusing
  it would break the "any `.sql`" promise.

Order is never changed — a dump is already emitted in dependency-safe order.

Then: two additive adapter methods behind two flags (`execute` /
`has_execute`; `execute_in_transaction(&[String])` / `has_atomic_restore`); the
empty-target gate reuses `list_tables` rather than adding introspection;
per-engine transaction strategy (Postgres and Turso atomic, D1 per-statement
because its HTTP API has no multi-statement transaction); `OnError::{Stop,
Continue}` with `Stop` the default, affecting only the non-atomic path.

ADR-0065 adds the wiring lessons: the plan **never crosses the IPC boundary** —
the run re-reads the file and re-plans internally, so a stale plan cannot be
executed; statement counts are of **runnable** statements only, transaction
control being stripped because the runner owns the boundary; cancellation
mid-run is **not an error** (a `cancelled` flag plus the applied count), and on
the atomic path it is only observed before the batch.

ADR-0051's own consequences say the quiet part: "Sibling `dbboard-web`: shares
the _concept_ (two-layer split, empty-target safety) but not code."

### What changes on web's side

#### 1. There is no SQL parser here, and this rung should not add one

Layer 2 on desktop is `sqlparser` with a real grammar. Web has no such
dependency, and pulling one in is a supply-chain decision (baseline §12) that
this rung does not need to make — because of what the classification is
actually _for_. Four of the five labels are **informational**: they populate
the counts the confirm dialog shows. Exactly one label changes behaviour:
`TransactionControl`, which gets stripped.

And `TransactionControl` is the one label a leading-keyword test gets exactly
right. `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`
and `RELEASE` are leading keywords by grammar — there is no statement that
_starts_ with `COMMIT` and means something else. The dangerous-looking case,
a PL/pgSQL body full of `BEGIN … END`, never reaches the classifier as its own
statement: Layer 1 keeps a dollar-quoted body intact, so a `CREATE FUNCTION`
whose body is `BEGIN … END` arrives as one statement whose leading keyword is
`CREATE`.

So Layer 2 becomes a leading-keyword classifier with desktop's stance
unchanged: never drop, never reject, label `Unparsed` when nothing matches and
run it verbatim. Degrade-open, no new dependency.

#### 2. The script has to get in, and both request gates forbid it

`main.ts` installs `contentTypeGuard` (415 on any POST whose `Content-Type`
first token is not exactly `application/json`) and
`app.useBodyParser("json", { limit: MAX_BODY_BYTES })` at the contract-pinned
64 KiB. Desktop has neither problem: it reads a file the user picked.

Both rules are contract text — but for the contract's endpoints.
`docs/api-contract.md` § Request-level rejections tabulates them next to
"Valid JSON missing the `sql` field → 422", which is `/query` and nothing else,
and `domain/limits.ts` scopes its own pin in writing: "a body above 64 KiB on
POST /query (and POST /connections/:id/query)". `/connections/*` is a web-only
unilateral surface — desktop never calls it, and the contract does not describe
it.

So the resolution is **narrow, not loose**. Restore accepts a raw
`application/sql` body — the media type dump already _emits_, which makes the
pair symmetric — and:

- `contentTypeGuard` gains one allowance: `application/sql` is accepted on the
  restore paths only. Every other path, including `/query`, keeps
  JSON-or-415 byte for byte.
- A second parser is registered, scoped by media type: Nest's text body parser
  bound to `application/sql` with its own `RESTORE_BODY_LIMIT_BYTES`. The JSON
  parser and its 64 KiB are untouched, so no contract endpoint can reach the
  larger limit — nothing else is allowed past the guard with that media type.

The larger limit sits **behind** `createBearerAuthMiddleware`, which `main.ts`
registers before any body parser. An unauthenticated request never allocates
the buffer.

Options (`confirmed`, `on_error`) travel as query parameters rather than in the
body, so the body stays pure script and needs no envelope.

#### 3. Re-plan-on-run means the script crosses the wire twice

ADR-0065's rule — the run re-reads the file rather than trusting a plan handed
back to it — is a correctness rule, not an IPC detail: it is what makes a stale
plan unexecutable. Web has no file to re-read, so the run request carries the
script again.

The alternative is staging the upload server-side under a token, and that is
state this codebase deliberately does not have. `InMemoryConnectionRegistry`
already mints ids per process; a staged-script store would be a second,
much larger per-process store needing an eviction policy, a size budget and a
story for what happens when two tabs stage at once. Sending the bytes twice is
stateless, cannot serve a stale plan, and costs one upload.

#### 4. The refusal cannot carry structured data, so the plan does

`RestoreError::TargetNotEmpty { existing }` carries the table names. Web's
error envelope carries `category` and `message` and nothing else — that is
contract, and this ticket does not change it.

Same re-shaping dump used for ADR-0050's warn-and-allow: the **plan** response
carries `existing_tables` and `is_target_empty` as ordinary data, and the run's
refusal is a `query`-category 400 whose message names the count. The UI already
holds the plan's list, so it can show which tables are in the way without the
error needing to say. This is now the second time an HTTP mirror of a desktop
in-process refusal has split into "plan returns the detail, run returns the
sentence" — the ADR should name the idiom.

#### 5. The per-statement path is unreachable today, and must still be built

Postgres will advertise `has_atomic_restore`, and it is web's only real
adapter. `NullAdapter` has no `execute` at all, so it refuses one step earlier.
That makes `run_per_statement` dead code on today's adapter set — and rung 7
brings D1, whose HTTP API has no multi-statement transaction, which is
precisely why desktop has the branch. Writing this down so a later
dead-code sweep does not delete it.

#### 6. Cancellation is a client disconnect

Desktop observes a `RestoreControl::is_cancelled` flag driven by the UI. The
HTTP equivalent is the request aborting. The use case takes an optional
`AbortSignal`; the controller wires it to the request's `close`. Desktop's
semantics carry over unchanged: checked between statements on the per-statement
path, checked once before the batch on the atomic path, and **not an error** —
the outcome reports `cancelled` alongside the count already applied.

#### 7. A whole script cannot go through `executeQuery`

Dump left this on the doorstep and it is worth restating as the reason Layer 1
is not optional. `pg` answers a multi-statement string with an _array_ of
results, so `result.fields` is `undefined` and the row mapper surfaces it as a 502. Splitting comes first, always.

## Slices

| Slice | Subject                                                                               | Layer                            |
| ----- | ------------------------------------------------------------------------------------- | -------------------------------- |
| A     | `splitStatements` — Layer 1, pure                                                     | `domain`                         |
| B     | `classifyScript` + plan helpers — Layer 2, pure                                       | `domain`                         |
| C     | `executeInTransaction` on the port and `PostgresAdapter`; flip `has_atomic_restore`   | `domain` port + `infrastructure` |
| D     | `RestoreDatabase` use case — plan, empty-target gate, atomic / per-statement, abort   | `usecase`                        |
| E     | `POST /connections/:id/restore/plan` and `…/restore`; the two request-gate exemptions | `presentation` + `bootstrap`     |
| F     | `useRestore` + the confirm dialog on the SQL page; `restore.*` across 11 locales      | `apps/web`                       |
| G     | Closeout — ADR, ledger rows, status, this log                                         | docs                             |

Each slice is RED before GREEN (baseline §4 / §20) and its own commit.

### Slice A — `splitStatements`

`apps/api/src/domain/split-statements.ts`, a port of `restore/split.rs`. Pure,
no dialect argument, no I/O. The adversarial cases from desktop's own tests
come across as-is: `''` doubling, `$tag$` with a body containing `;`, `$1`
being a placeholder and not a dollar-quote opener, nested `/* /* */ */`, `--`
to end of line, backslash inside `E'…'` versus a trailing backslash in a plain
`'…'`, unterminated constructs consuming to EOF, comment-only input producing
an empty array, and a trailing statement with no semicolon.

### Slice B — `classifyScript`

`apps/api/src/domain/classify-statements.ts`. `StatementKind` as a string
union (`"ddl" | "data" | "transaction_control" | "other" | "unparsed"` — the
project's convention over `enum`), `RestoreStatement`, `runnableStatements`,
and the counts the plan reports. The `TransactionControl` set is the one that
must be exact; `Ddl` and `Data` are leading-keyword best-effort; anything
unmatched is `unparsed` and still runnable.

### Slice C — `executeInTransaction`

Optional method on `DatabaseAdapter`, mirroring `execute?`'s existing comment
that splitting belongs to the caller. Postgres implementation issues `BEGIN`,
the statements, `COMMIT`, and `ROLLBACK` on failure, on **one** pooled client —
`postgres-adapter.ts` must not hand the statements to different connections.
`capabilities()` flips `has_atomic_restore: true`; `postgres-adapter.spec.ts`'s
exact-shape assertion updates with it.

### Slice D — `RestoreDatabase`

`prepare` / `run`, the shape dump proved: everything that can refuse resolves
before anything runs. `prepare` lists tables and classifies; `run` re-splits
and re-classifies from the script it is given (never from a plan handed back),
refuses `TargetNotEmpty` unless `confirmed`, refuses `Unsupported` without
`has_execute`, then takes the atomic branch or the per-statement branch.
Outcome mirrors `RestoreOutcome`: `statements_run`, `ddl_run`, `data_run`,
`failures`, `cancelled`, `atomic`, `unparsed_count`.

### Slice E — the two routes

`ConnectionRestoreController`, no history interceptor (same reason as dump and
write-back: history is the record of queries the user ran). Plan returns
`existing_tables`, `is_target_empty` and the counts; run returns the outcome.
Both take the script as a raw `application/sql` body. `RESTORE_BODY_LIMIT_BYTES`
lands in `domain/limits.ts` next to the two contract-pinned values, with a
comment saying explicitly that it is **not** contract-pinned and why: the
constraint is holding the script plus its split array in memory, not a wire
promise. A streaming split is the follow-on if the ceiling ever binds; desktop
holds the whole file in a `String` too.

### Slice F — the UI

Mirrors `BackupState`: Idle → Planning → Confirming → Blocked → Running → Done
/ Failed. The blocked state is the one that matters — it names the existing
tables from the plan and requires an explicit confirm before the second
request goes out.

## Definition of done

- Rung 6b closes; `has_atomic_restore` is `true` for Postgres and the ledger
  row for ADR-0051 is `done`.
- A `pg_dump --inserts` script and a dbboard dump both restore into an empty
  database.
- A non-empty target refuses without `confirmed` and the UI can say which
  tables are in the way.
- A failing statement inside the atomic path leaves the database untouched.
- `docs/api-contract.md` has a zero diff against `86b324f` (six rungs running).
- Full gate green, Docker up: `pnpm format:check`, `pnpm -r lint`,
  `pnpm -r typecheck`, `pnpm -r test`.
- `sh scripts/pii-scan.sh --staged` and `--tree` clean.

## Log

_(slices appended as they land)_

$$
$$
