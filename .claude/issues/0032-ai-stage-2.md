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

### B — more than one provider (done)

Definition-of-done item 2, and item 9 re-checked.

Desktop's version of this is a settings window: `ai-providers.toml` beside the
OS keychain, a list you edit, a key you paste (ADR-0025). Web can have the
list and cannot have the window. A server has no keychain, and accepting a key
over HTTP would put credential writing behind a bearer token — which baseline
§15 reserves for the operator, deliberately and after a real incident. So what
crossed is not the UI but the thing the UI existed to produce: more than one
configured provider, and a way to say which one answers.

The config reader mirrors ADR-0025's _parse posture_ rather than its syntax. A
duplicate id, an unset `_KIND` or `_API_KEY`, a kind this build cannot
construct, and a `DBBOARD_AI_DEFAULT` naming nothing are all boot failures. A
deployment that starts while silently missing a provider tells its operator
nothing; the user finds the gap instead, which is the wrong order. Ids are
`[a-z0-9-]+` so that the id → variable-suffix mapping (`-` → `_`, uppercased)
cannot make two ids collide on one variable.

`DBBOARD_ANTHROPIC_API_KEY` did not become a special case. It is read as an
ordinary entry, first in the list, id `anthropic` — so a Stage 1 deployment
gets a one-entry registry that behaves exactly as its single provider did, and
one that later adds a list keeps the default it had yesterday.

Resolution moved out of the recorded call and in front of it. `runRecordedAiCall`
no longer has a `provider === undefined` branch: by the time it runs there is a
provider. That matters for the record, not just for tidiness — a refusal now
writes nothing, because no provider was reached, and the v:2 schema requires a
provider and a model that would have to be invented.

Two refusals, two statuses, and the split is the point:

- Nothing configured → `404 ai_disabled`, the answer Slice 2 already gave. The
  panel reads it as "this deployment has no AI" and renders the neutral notice.
- A name this deployment does not have → `422 ai_unknown_provider`, naming the
  id. That is a bad request, not a configuration.

`GET /ai/providers` answers 404 on an empty registry rather than
`200 { providers: [] }`, and the decision lives in the use case rather than the
controller. Otherwise the panel would have to decide for itself what an empty
array means, and its conclusion would have to agree with what `/ai/explain`
says — three signals that could disagree instead of one that cannot.

On the web side the selection is panel state, so it is an option on
`useAiAssist` rather than a fourth positional on `suggestSql`, and a getter
rather than a value: changing the selector must not rebuild the composable and
drop the response already on screen. The panel names a provider only when
there is more than one. One provider is not a choice — rendering a select with
a single option asks the user to confirm something they cannot change, and
putting its id on the wire would change the shape of every Stage 1
deployment's requests for nothing the server can act on.

`useAiProviders` is separate from `useAiAssist` because their lifetimes
differ: one question at mount, many on button presses, and a failure of either
must not put the other into an error state. A provider list that fails to load
for an ordinary reason leaves the panel fully usable — the server still has a
default, and a request naming nobody still reaches it. Only `ai_disabled`
changes what the panel shows, and it now arrives before the user presses
anything rather than after a failed explain.

Coverage was relocated, not dropped, at the two places behaviour was deleted.
The `runRecordedAiCall` disabled-branch case and the six `bootstrap/config.ts`
AI env cases each have a comment at the old site naming the new home
(`static-ai-provider-registry.spec.ts`, the two use-case specs, and
`ai-providers.config.spec.ts` against the same two variable names).

Gate green: format, lint, typecheck, 1266 api + 1250 web tests. `pnpm -r test`
still reports one skipped file (the D1 live suite, maintainer-held credentials,
see 0031).

### C — streaming, cancel, token meter (done)

Definition-of-done items 3, 4, 5 and 6. Two commits, because the halves fail
differently and nothing in the browser could be written against a route that
did not exist yet: the API half is `528035e`, the browser half is this one.

`StreamEvent` is a normalized five-variant union (`message_start`,
`text_delta`, `usage`, `message_stop`, `error`) rather than the provider's own
frames, which is ADR-0026 Decision 3 and the reason slice D can add OpenAI
without touching a consumer. The port's `stream*` methods have **default
implementations that delegate to the atomic call and yield the answer as a
single chunk** (Decision 2): a provider is never required to stream, and the
routes never have to ask whether this one can. What varies is the honesty flag
`streaming`, which is what the panel gates its toggle on (Decision 8) — every
provider answers the streaming routes, so without the flag the toggle would
promise chunks and, for a delegate, deliver one.

The routes are `POST /ai/explain/stream` and `POST /ai/suggest/stream`, taking
the same bodies as their atomic siblings. **Provider resolution runs before
the response is touched**, so `404 ai_disabled` and `422 ai_unknown_provider`
are still JSON envelopes with status codes; only a failure past the headers
becomes an in-band `error` frame. A stream cannot un-send a 200, and a client
that must parse SSE to discover the deployment has no AI would be a worse
contract than the one slice B just built. Framing is `data: <json>\n\n` with no
`event:` names — the type is inside the object, so a reader needs one branch
rather than two. `X-Accel-Buffering: no` because a proxy that buffers turns
streaming back into an atomic call without saying so.

Cancel is drop-the-stream (Decision 5). `pipeAiStream` races `iterator.next()`
against the client hangup, and on hangup calls `iterator.return()` so the
generator's `finally` runs: that aborts the upstream request and writes the
record. **Exactly one history record per call, at the terminus, cancelled ones
included** — carrying the text assembled so far, the tokens actually spent and
`cancelled` as its own status rather than as a failure. Its numbers are rung
1's v:2 `tokens_in` / `tokens_out`, which is why ADR-0026 waited for it.

The meter **replaces on each `usage` frame rather than summing** (Decision 7).
Anthropic's `message_delta.usage.output_tokens` is already cumulative, so
addition would roughly double the figure; item 5's test drives a stream
reporting 20 then 45 output tokens and asserts 45, which a summing
implementation would fail with 65. A `null` count is "this event reported
none", not "none were spent", so it leaves the previous figure standing rather
than erasing what `message_start` already gave.

The browser half is three pieces. `internal/sse.ts` is a generator over
`fetch`, because `apiFetch` forwards to `$fetch` and there is no point in that
call where a half-arrived answer exists; frame decoding is a pure function kept
apart from the reader loop so the awkward case — a frame split across two
chunks — is testable without a socket. Its `finally` cancels the reader, so a
consumer that stops early closes the request rather than leaving the provider
generating tokens nobody will read. `useAiAssist` gained a `streaming` state
(distinct from `loading`: one has nothing to show, the other has a partial
answer and a Cancel button), `tokensIn` / `tokensOut` / `wasCancelled`, and a
per-invocation `StreamRun` whose identity is checked before any write — so a
superseded stream cannot land frames on the run that replaced it, and an abort
issued to clear the way is not reported as the user cancelling. `AiPanel`
gained the toggle, the Cancel button, the meter and a `Cancelled` line.

Two decisions in the panel are worth the sentences they cost:

- **The dispatch is gated, not just the DOM.** `useStreaming = streamMode &&
selectedStreams`. Hiding the checkbox for a provider that does not stream
  leaves its ref `true` behind the hidden box, and the next Send would still
  take the streaming route — the test that pins this switches provider while
  the toggle is on and asserts the atomic call.
- **Cancel is offered only while streaming.** Decision 10 enables it whenever
  the panel is busy; web's atomic path is a `fetch` already in flight inside
  `apiFetch` with nothing a click could stop, so a button there would be an
  offer the browser cannot keep. `cancel()` stays idempotent and safe to call
  when idle, so the divergence is in what is rendered and not in the API.

Cancelling renders as its own line with no error banner, and whatever text
arrived before the stop stays on screen (Decision 12) — a cancel is a thing the
user did, not a thing that went wrong. The toggle is unchecked by default
(Decision 9), so a deployment that never touches it behaves exactly as it did
before this slice: item 9 re-checked, and `docs/api-contract.md` still zero
against `86b324f` (item 10).

Item 6's two-halves capability test is asserted the way rung 7 Decision 1
established: `streaming: true` against the Anthropic adapter's real override,
`false` against a provider left on the delegate, so the flag is proved against
behaviour rather than against a literal that agrees with itself.

`docs/deployment.md` gained the two `/stream` rows, the descriptor's
`streaming` field, and the SSE / cancel / token paragraphs. Five keys across
eleven locales (`ai.stream.toggle`, `ai.cancel.button`, `ai.tokens.meter`,
`ai.state.cancelled`, `error.prefix.ai-unknown-provider` — the last one slice
B's 422 had left untranslated).

Gate green: format, lint, typecheck, 1324 api + 1354 web tests. Still the one
skipped file (the D1 live suite, maintainer-held credentials, see 0031).

### D — OpenAI (done)

Definition-of-done item 7, and the first slice that proves slice C's claim:
the whole browser half is untouched here. A second provider kind reaches the
panel through `GET /ai/providers` and the normalized `StreamEvent`, so nothing
in `useAiAssist` or `AiPanel.vue` learned the word "openai".

Four files carry it, and the first two are extractions rather than new
behaviour. `anthropic-provider.ts` had grown the shared half of every adapter
inside it — the two system prompts, the two prompt builders, `qualify`,
`normaliseStopReason`, `tokenCount` and `categoriseUpstream`. Copying those
into a second adapter would have made the next prompt fix a two-file edit that
compiles either way, so they moved to `ai-prompts.ts` and
`ai-response-mapping.ts` first. The extraction is behaviour-preserving in the
only sense that counts: `anthropic-provider.spec.ts` passes its 30 cases
**without a single edit** after the adapter switched to importing them. Slice E
lands its `full_schema` builder change in `ai-prompts.ts`, once.

`openai-transport.ts` is a hand-rolled `fetch` client rather than the `openai`
npm package. Baseline §12 asks what a dependency buys: the SDK's value is
retries, typed model catalogues and the streaming helper, and this adapter
wants none of them — the port already normalizes the frames, and the surface
actually used is one POST to `/v1/chat/completions`. Against that, an SDK on
the request path of a route that carries the deployment's credential is a
supply-chain surface with a transitive tree. The frame decoder is a pure
`decodeSseFrames(buffer) -> {frames, rest}` so a split multi-byte boundary is
tested rather than hoped for, and `assertKeySafeToSend` refuses any base URL
that is neither https nor loopback — a mistyped `http://` gateway would
otherwise put the key on the wire in the clear.

`openai-provider.ts` differs from the Anthropic adapter on exactly four axes,
and the header says so, because the next reader's question is whether it is a
fork. Auth is `Authorization: Bearer <key>` and lives in the transport. The
system prompt is a `{"role":"system"}` entry at the head of `messages` instead
of a top-level field. Usage is `prompt_tokens` / `completion_tokens`. The
terminus is `finish_reason` in OpenAI's vocabulary, translated to the canonical
set through a **`Map` and not an object literal** — `finish_reason` is upstream
input, and `{}["constructor"]` is not `undefined`.

Two smaller decisions are worth their sentences:

- **No output cap is sent.** Anthropic's adapter pins `max_tokens: 1024`
  because the API requires it. OpenAI's does not, and the parameter's name
  changed under it: `gpt-4o` takes `max_tokens`, the o-series and gpt-5 reject
  it in favour of `max_completion_tokens`. Sending nothing is the only choice
  that lets `DBBOARD_AI_<ID>_MODEL` name an arbitrary model without this file
  learning a model table it would then have to be kept current with.
- **`message_start` is emitted lazily**, on the first parsed chunk, so it can
  carry the model and any usage the provider front-loaded. A stream that
  carried nothing at all still gets a `message_start` and exactly one
  `message_stop`, because the consumer's terminus handling is the same code
  path that writes the history record.

Configuration needed one word: `KNOWN_KINDS` gained `"openai"`. That is what
the `never`-assignment guard in `app.module.ts` is for — widening the union
broke the build until the factory grew its branch, which is the exhaustiveness
check doing the job it was added for rather than a test catching a gap later.
There is deliberately **no** legacy two-variable shortcut for OpenAI:
`DBBOARD_ANTHROPIC_API_KEY` exists to keep Stage 1 deployments booting
unchanged, and there is no Stage 1 OpenAI deployment to keep.

`docs/deployment.md` gained `openai` in the `_KIND` row, `gpt-4o` in the
`_MODEL` row, and a section with the env block and the two caveats an operator
would otherwise hit at runtime — no output cap, and **the base URL is not
configurable by environment today**. The adapter accepts one so a gateway can
be put in front later; the factory does not pass one, and the docs say that
rather than implying a control that does not exist (baseline §10).

Gate green: format, lint, typecheck, 1399 api + 1354 web tests (api was 1324
before this slice; the provider suite is 36 cases against a stubbed transport,
the same suite Anthropic answers). Still the one skipped file.
