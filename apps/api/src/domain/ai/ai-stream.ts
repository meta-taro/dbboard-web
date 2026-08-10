// The streaming half of the AI port, expressed as free functions rather
// than methods.
//
// Desktop states this as a trait with default bodies (ADR-0026 Decision
// 2): every provider gets `stream_explain` for free, and one that has a
// real SSE transport overrides it. TypeScript has no default method, and
// the alternative — an abstract base class every adapter must extend —
// would make streaming a thing providers opt into structurally, when the
// whole point of Decision 2 is that callers never branch on which kind
// of provider they hold.
//
// So the default body lives here. `AiProvider.streamExplain` is
// optional; when it is absent these functions call the atomic method and
// shape the single answer into the same event sequence a real stream
// would end with. A caller writes one loop either way.

import type {
  AiProvider,
  AiResponse,
  AiStreamOptions,
  ExplainRequest,
  StreamEvent,
  SuggestRequest,
} from "./ai-provider.port";

// The one-chunk sequence. It is a full stream, not an abbreviation of
// one: `message_start` opens it, the whole answer arrives as a single
// `text_delta`, `usage` reports the counts the atomic call returned, and
// `message_stop` carries its stop reason. A recorder or a panel that
// handles a real stream handles this without a special case.
//
// No `error` event is synthesised — a rejected atomic call is left to
// reject. The in-band `error` variant exists because a stream that has
// already sent its 200 has nowhere else to put a failure, and that
// situation cannot arise before the first event.
//
// Takes a thunk rather than a promise so the call starts on the first
// `next()`, the way an override's generator body does. Invoking it
// eagerly would also mean a rejection could go unhandled in the window
// between building the iterable and iterating it.
async function* fromAtomic(call: () => Promise<AiResponse>): AsyncGenerator<StreamEvent> {
  const response = await call();
  yield { type: "message_start", tokensIn: response.tokensIn, model: response.model };
  yield { type: "text_delta", text: response.text };
  yield { type: "usage", tokensIn: response.tokensIn, tokensOut: response.tokensOut };
  yield { type: "message_stop", stopReason: response.stopReason };
}

export function streamExplain(
  provider: AiProvider,
  request: ExplainRequest,
  options?: AiStreamOptions,
): AsyncIterable<StreamEvent> {
  if (provider.streamExplain) return provider.streamExplain(request, options);
  return fromAtomic(() => provider.explain(request));
}

export function streamSuggestSql(
  provider: AiProvider,
  request: SuggestRequest,
  options?: AiStreamOptions,
): AsyncIterable<StreamEvent> {
  if (provider.streamSuggestSql) return provider.streamSuggestSql(request, options);
  return fromAtomic(() => provider.suggestSql(request));
}
