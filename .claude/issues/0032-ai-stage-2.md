# 0032 — AI stage 2: schema in the prompt, a provider the caller picks, and a stream the caller can hang up on

**Status:** open · **Opened:** 2026-08-09 · **Rung 8** (last) of
[`../parity-ledger.md`](../parity-ledger.md)

## Purpose

Web's AI surface is desktop's Stage 1 and nothing more: one provider, read from
one environment variable, answering two atomic requests. Desktop shipped three
more ADRs on top of that, plus two decisions web deferred off rung 4.

| Desktop ADR         | What it added                                          | Web today                         | Slice |
| ------------------- | ------------------------------------------------------ | --------------------------------- | ----- |
| ADR-0028 Decision 8 | `SuggestRequest.schema` — the table list in the prompt | `SuggestRequest` has neither half | A     |
| ADR-0025            | Provider config, list, runtime switch                  | one env var, no choice            | B     |
| ADR-0026            | Streaming, cooperative cancel, token meter             | atomic only, no meter             | C     |
| ADR-0052            | OpenAI provider                                        | Anthropic only                    | D     |
| ADR-0028 Decision 9 | `full_schema` behind `has_describe_table`              | absent                            | E     |

AI is optional by `CLAUDE.md` rule 4, which is why this rung is last: every
slice in it must leave a provider-less deployment working exactly as it works
today.

## Survey

Per baseline §19 the shipped desktop code is the authority. Surveyed at
**`b98f7a6`** (mainline, v0.5.1) — unchanged since rung 7. `develop` is
`8f326d8`, still the ADR-0091 nested-`Value` branch and still not to be
mirrored.

### What was read

`crates/dbboard-ai/src/{provider,capabilities,stream,request}.rs` at `b98f7a6`;
`docs/decisions.md` ADR-0025, ADR-0026, ADR-0052 in full and ADR-0028
Decisions 8–9. On the web side: `domain/ai/ai-provider.port.ts`,
`infrastructure/anthropic-provider.ts`, `usecase/record-ai-call.ts`,
`presentation/ai.controller.ts`, `composables/useAiAssist.ts`.

### The `dbboard-mcp` question, answered

Rung 7's closeout noted that `dbboard-mcp` is on desktop `main` and wondered
whether web's ledger accounted for it. It does — ADR-0046 / 0053 / 0054 are
already a `n/a` row, and ADR-0087 / 0088 (the MCP write gate) are another. No
gap. Recording the answer so the question is not re-opened a third time.

### Four things that do not cross the process boundary

Desktop is one user in one process. Web is a server with more than one client.
Four of these ADRs' decisions are shaped by that difference, and mirroring them
literally would be wrong.

**1. There is no keyring, so there is no place to put a key the operator
typed.** ADR-0025's whole persistence story is `ai-providers.toml` plus
`dbboard.ai.<id>.api_key` in the OS keychain, and it rejects every alternative
on the grounds that the keychain is the right home for the secret. Web has no
keychain and no per-user config directory — the same reason ADR-0013 / 0033 sit
in Category C. Accepting an API key over HTTP so the server can store it would
put credential writing behind a bearer token, which baseline §15 places in the
maintainer's hands and nowhere else. **Providers on web are configured from the
environment.** What survives the mirror is not the settings UI but the thing
the settings UI existed to produce: more than one configured provider, and a
way to say which one answers.

**2. A globally mutable "active provider" is a shared mutable in a
multi-client server.** ADR-0025 Decision 5 swaps an
`Arc<RwLock<Option<Arc<dyn AiProvider>>>>` because in a desktop process the
person switching and the person asking are the same person. On web they are
not: a switch by one browser would silently change what another browser's next
question is answered by, and neither would see it happen. **The provider is
named per request** (an optional field, defaulting to the configured default),
and the selector in the panel is client-side state. This keeps the user-visible
outcome of ADR-0025 — choose who answers — and drops the mechanism that only
made sense for one user.

**3. Cancel cannot be a token the caller holds, and does not need to be.**
ADR-0026 Decision 5 cancels by dropping the stream. Over HTTP the client
already has that verb: it hangs up. Web established this in rung 6b for the
dump route, whose controller writes with backpressure and treats the response's
`close` event as the abort signal. Streaming AI reuses that shape rather than
inventing a `POST /ai/cancel`, which would need a request id, a registry of
in-flight requests keyed by it, and an answer for what happens when the process
holding the registry is not the process holding the stream.

**4. Desktop does not record streams; web already records AI calls.**
ADR-0026 says the per-record history schema is unchanged because streaming
responses are not written to `history.jsonl` at all — Group C (ADR-0027) is
where that was debated, and desktop's Group C landed atomic-only. Web is
already past that point: since ticket `0023` every AI call writes a v:2
`kind: "ai"` record. So a decision desktop never had to make falls to web —
what a streamed call records, and what a cancelled one records. The answer this
ticket takes: **one record at terminus, and a cancelled stream is recorded**,
because it spent tokens and a history that loses spend is not a cost record.
The vocabulary already has room for it: `stop_reason` takes `other:<text>` for
anything outside the canonical five, so `other:cancelled` needs no schema
change and keeps the byte-mirror with desktop brief 0008 intact.

### What crosses unchanged

- **`StreamEvent` normalized rather than passed through.** ADR-0026 Decision 3
  exists so the trait does not become Anthropic-shaped. The same argument holds
  a fortiori on a wire that a browser parses.
- **Usage is cumulative — replace, never sum** (Decision 7). Anthropic's
  `message_delta.usage.output_tokens` is a running total. Summing double-counts.
- **`has_streaming` is a contract** (Decision 8), not a hint: a provider that
  advertises it must override the streaming path; one that does not gets a
  default that yields the atomic answer as a single chunk. Web's capability
  object already carries the flag (`streaming`), and every provider so far
  reports `false`. It goes true where it is earned.
- **No silent retry on a token-billed POST** (Decision 4). A transparent retry
  bills twice and makes the meter lie.
- **No silent fallback between providers** (ADR-0025 Decision 3). A named
  provider that is not configured is an error, not a quiet substitution.
- **`gpt-4o`, Chat Completions, `Authorization: Bearer`, `data: [DONE]`,
  `stream_options.include_usage`** (ADR-0052) port directly. Its Consequences
  ask web to keep the `kind` string `openai` aligned; the keyring-ref half has
  no web counterpart.
- **`full_schema` is preferred when non-empty, terse `schema` otherwise**
  (ADR-0028 Decision 9), the checkbox defaults off, and a partial
  `describe_table` fan-out warns without blocking the request.

## Slices

Bottom-up, same as rung 7: the port first, then the adapter, then the route,
then the UI. Each slice is TDD per baseline §4 / §20 and gates before commit.

- **A — `SuggestRequest.schema`.** The terse half of ADR-0028 Decision 8. Port
  field, DTO validation, prompt rendering, and the panel filling it from the
  table list it can already reach on `/connections/:id/sql`. Optional
  everywhere: a suggest with no schema must behave exactly as it does today.
- **B — more than one provider, and the caller names one.** A provider registry
  built from environment configuration, `GET /ai/providers` (id, kind, model,
  which is default), and an optional `provider` field on both AI requests.
  Unknown or unconfigured id → an error that names it.
- **C — streaming, cancel, token meter.** SSE routes mirroring `StreamEvent`,
  the Anthropic SSE adapter behind `streaming: true`, one history record at
  terminus including the cancelled case, and the panel's stream toggle, cancel
  button and meter.
- **D — OpenAI.** ADR-0052, with streaming parity from the start because C
  precedes it.
- **E — `full_schema`.** ADR-0028 Decision 9 behind the per-connection
  `describe_table` capability, with the bounded parallel fan-out and the
  non-blocking partial-failure warning.
- **F — closeout.** Docs, ledger rows, `decisions.md`, and this ticket.

## Definition of done

1. A suggest carries the table list, and one with no schema is byte-identical
   in behaviour to today's.
2. Two providers can be configured at once; a request can name either; naming
   an unconfigured one fails with a message that says which one.
3. A streamed explain renders incrementally, and hanging up mid-stream stops
   the upstream request rather than merely abandoning its output.
4. A cancelled stream leaves exactly one history record, carrying the partial
   text and the tokens actually spent.
5. The token meter shows the cumulative figure, proven by a test whose stream
   would report double if the numbers were summed.
6. `streaming: true` is asserted against a real override, and `false` against
   the delegate — the two-halves capability test rung 7 Decision 1 established.
7. The OpenAI provider passes the same provider-level suite as Anthropic,
   against a stubbed transport.
8. `full_schema` is sent only when the connection advertises `describe_table`
   and the box is ticked; a partial fan-out still fires the request.
9. A deployment with no provider configured behaves exactly as it does today —
   404 from both routes, panel hidden, nothing recorded (`CLAUDE.md` rule 4).
10. `docs/api-contract.md` diff against `86b324f` stays zero. The AI routes are
    web-unilateral by desktop ADR-0023 Decision 3, and stage 2 adds no reason
    to change that.

## Work log

### A — `SuggestRequest.schema` (done)

Definition-of-done item 1. `SuggestRequest` grew an optional `schema:
TableInfo[]`, `AiSuggestRequestDto` a nested `AiTableInfoDto` validated the way
`update-row.dto.ts` validates its key columns, and `buildSuggestPrompt` now
mirrors desktop's ordering — tables, dialect, request — with desktop's
`qualify` rule for the bare-vs-qualified name.

Three states, not two, and the third is the one desktop cannot have. Desktop
always passes a list, so it always emits the block. Web's field is optional, so
absent means the caller never looked and the block is omitted entirely — which
is what makes a suggest with no schema byte-identical to the one it sent
before this slice, rather than merely similar. `[]` is the interesting middle:
it is a claim, and the prompt states it, because silence lets the model invent
a plausible table and "(no tables introspected)" does not.

The same distinction had to survive three more boundaries, and each one was a
place it could have been quietly lost:

- The DTO accepts an entry with no `schema` key (SQLite and D1 have no schema
  concept) and the controller normalises that to `null`, so the domain has one
  spelling of "unqualified" rather than two.
- `useAiAssist.suggestSql` omits the key when handed nothing and sends `[]`
  when handed `[]`. A test reads the body back and asserts the _absence_ of the
  property, which `toEqual` would not have caught.
- The page, not the panel, decides whether there is a list to send. The
  sidebar's `tables` is `[]` while the fetch is in flight and `[]` again if it
  failed, and forwarding either would tell the model this connection has no
  tables when the truth is that we never found out. So `SchemaBrowser` exposes
  `state` alongside `tables` and the page forwards only on `idle`. Two of the
  four page-level tests cover exactly those two false-empty cases.

`AiPanel` takes the list as a prop rather than fetching it, which keeps it and
the composable as connection-agnostic as they were documented to be — the page
is where the sidebar and the panel already meet. `explain` was left alone: it
has the SQL, which is the context it needs.

Gate green: format, lint, typecheck, 1211 api + 1208 web tests. `pnpm -r test`
reports one skipped file (the D1 live suite, which needs maintainer-held
credentials — see 0031).
