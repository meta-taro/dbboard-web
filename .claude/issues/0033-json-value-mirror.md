# 0033 — The `$json` variant: web accepts a cell that holds a document

**Status:** closed 2026-08-11 · **Opened:** 2026-08-11 · **Rung 9** of
[`../parity-ledger.md`](../parity-ledger.md) — a category A row, not a feature.

## Purpose

Desktop shipped the nested `Value` variant to mainline and put the tag in the
shared contract. The ledger's ADR-0091 row has said since 2026-08-06 that web's
move is to **wait for that commit and mirror it, not to invent a tag**. The
commit exists now, so the wait is over.

This rung mirrors the wire form only. It does not add a document-store adapter.

## Survey

Per baseline §19 the shipped desktop code is the authority, and per the ADR-0091
row the authority is **mainline**, never the working checkout. Surveyed at
`origin/develop` = **`e064717`** (v0.7.0). The previous pin was `b98f7a6`
(v0.5.1); 14 commits and two releases separate them.

The local desktop checkout sits on `test/firestore-emulator-fixture` with
uncommitted changes. It was not read. Reading it is the exact defect the
ADR-0091 row records having caught once already.

### The contract change

`docs/api-contract.md` gained a row and a section (`8f326d8`, PR #148):

| Domain variant | JSON encoding             | Example                        |
| -------------- | ------------------------- | ------------------------------ |
| `Json(tree)`   | `{ "$json": <any JSON> }` | `{ "$json": { "a": [1, 2] } }` |

Five rules come with it, and each one is a test below:

1. Exactly one key, like `$blob`.
2. **The payload is opaque.** It is ordinary JSON, not a nested `Value`. A
   document containing a `"$blob"` key _is that document_ — consumers must not
   walk into the tree looking for tags.
3. `{ "$json": null }` is a document whose content is JSON null. It is **not**
   SQL `NULL`, which stays bare `null`.
4. A `Text` cell and a `$json` cell may render to the same characters. The tag
   is the only thing that distinguishes them.
5. Render a document readably — its JSON text is the minimum — **not**
   `[object Object]`.

Rule 5 is stated in the contract because it is the obvious way to get it wrong,
and web currently gets it wrong.

### Two defects that already exist

Neither needs a document store to reproduce. A `$json` cell on the wire is
enough, and the contract says a consumer must accept one as of this version.

**`apps/web/app/utils/sort.ts:34`** — `isBlob` narrows on `typeof === "object"`
alone, so any tagged object is a blob to it:

```ts
function isBlob(value: Value): value is { $blob: string } {
  return typeof value === "object" && value !== null;
}
```

A `$json` cell reaches `compareStrings(a.$blob, b.$blob)` with both sides
`undefined`. `rank()` puts it in the blob bucket for the same reason.

**`apps/web/app/utils/format-value.ts:32`** — `isBlob` here _does_ check the
key, so `$json` falls past it to the exhaustiveness fallback and renders as
`String(value)` — literally `[object Object]`, the one output the contract
names.

## Slices

| Slice | Where                                                      | What                                                                |
| ----- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| A     | `docs/api-contract.md`                                     | Mirror the row and the `$json` section verbatim in meaning          |
| B     | `apps/api/src/domain/values/value.ts` (+ `index`)          | `JsonValue`, `isJsonValue` (exactly-one-key), `Value` union         |
| C     | `apps/web/app/composables/useQueryExecution.ts`            | Web-side `Value` union                                              |
| D     | `apps/web/app/utils/format-value.ts`                       | `kind: "json"`, readable text, no `[object Object]`                 |
| E     | `apps/web/app/utils/sort.ts`                               | Own rank bucket; fix the `isBlob` over-narrowing                    |
| F     | `apps/api/src/domain/dump/literal.ts`, `update-row.dto.ts` | Dump literal and write-back acceptance                              |
| G     | ledger / decisions / status                                | Close the ADR-0091 row, re-pin to `e064717`, classify ADR-0093…0096 |

## Out of scope, and why

**The Firestore (ADR-0093/0094) and MongoDB (ADR-0095/0096) adapters.** They are
category B, not category A. The contract itself says _"No SQL adapter emits
`$json` today … a consumer must accept the tag anyway, because the variant is on
the wire as of this contract version."_ Web's obligation is the receiving end,
and it is separable — which is why it is this rung and the adapters are not.
Ledger rows are added for them so the decision is a lookup later, not a
re-survey.

## Definition of done

- [x] `$json` survives a round-trip through the API `Value` type with the
      payload untouched, including when the payload contains a `$blob` key
- [x] `{ $json: null }` and bare `null` are distinguishable at every layer
      — down to `valueLiteral`, which emits `'null'` for the document and
      `NULL` for the SQL null
- [x] No layer renders a document as `[object Object]`
- [x] Sorting a column holding `$json` is total and does not throw
- [x] `docs/api-contract.md` matches desktop's `e064717` in meaning
      — in fact byte-identical, see the closeout note below
- [x] Ledger ADR-0091 row moves `todo` → `done`, pin updated, 0093–0096 classified

## Closeout

Three things came out of the rung that the survey above did not predict.

**A third copy of the over-broad `isBlob`, in `ResultGrid.vue`.** The survey found
two (`sort.ts`, `format-value.ts`); the component had a third, and it was the
only one that gave the _right_ answer for the wrong reason — a document is
uneditable, but not because it is a blob. The predicate is now split into
`isBlob` / `isJson` with `isUneditable` composing them, so the next tagged shape
has an obvious place to go rather than a third `typeof` test to hide behind.

**The viewer refused documents, which the ticket did not know.** `openViewer`
guarded on `typeof cell === "object"`, so a document too wide for its column was
truncated in the grid with no way to read it — desktop's `openCell` opens it.
This was slice D's real cost: the same over-broad test had conflated _uneditable_
with _unviewable_, two rules that only coincide for blobs.

**Slice A had to be redone.** It was first written as a hand edit adding
web-specific commentary. `.prettierignore` declares `docs/api-contract.md` a
mirror that "must remain content-identical", so the file was replaced wholesale
with `git show origin/develop:docs/api-contract.md` instead, and the web-specific
reasoning moved to [`decisions.md`](../decisions.md). That replacement also
closed pre-existing drift: the intro paragraph still described the Tauri client
as consuming the server over HTTP, which desktop retired in ADR-0089.

`update-row.dto.ts` and `export.ts` needed no change — write-back rejects on the
domain side, and CSV export renders through the same formatter.

## Verification

```sh
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm format:check
```
