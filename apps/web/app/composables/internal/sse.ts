/**
 * Server-sent events, for the AI streaming routes (ticket 0032 slice C2).
 *
 * Its own module for two reasons. The transport one: `apiFetch` forwards
 * to `$fetch`, which resolves a parsed body — there is no point in the
 * call where a half-arrived answer exists, which is exactly what a stream
 * is. So this reaches for `fetch` directly. The testing one: the same
 * reason `internal/http.ts` exists — composable tests replace this module
 * with `vi.mock` rather than standing up a fake network.
 *
 * `decodeSseFrames` is kept pure and separate from the reader loop so the
 * awkward part — a frame that arrives in pieces — can be tested without a
 * socket at all.
 */

export interface SseDecodeResult {
  /** Payloads of every frame that finished arriving, in order. */
  events: unknown[];
  /** The unfinished tail. Feed it back in front of the next chunk. */
  rest: string;
}

// SSE ends a frame with a blank line. CRLF is accepted because the
// separator is what a proxy is most likely to rewrite on the way through.
const FRAME_SEPARATOR = /\r?\n\r?\n/;
const LINE_SEPARATOR = /\r?\n/;
const DATA_FIELD = "data:";

export function decodeSseFrames(buffered: string): SseDecodeResult {
  const parts = buffered.split(FRAME_SEPARATOR);
  // The last piece has no terminator yet, so it is by definition
  // unfinished — empty when the buffer ended on a frame boundary.
  const rest = parts.pop() ?? "";
  const events: unknown[] = [];
  for (const frame of parts) {
    const payload = parseFrame(frame);
    if (payload !== SKIP) events.push(payload);
  }
  return { events, rest };
}

// A sentinel rather than `undefined`, so a frame whose payload really is
// `null` stays distinguishable from one we could not read.
const SKIP = Symbol("unreadable frame");

function parseFrame(frame: string): unknown {
  // Other fields (`event:`, `id:`, `retry:`) and comment lines (`:`) are
  // ignored: the API names no frames, because the type is already inside
  // the payload (see ai-sse.ts). Multiple data lines join with a newline,
  // per the SSE grammar.
  const data = frame
    .split(LINE_SEPARATOR)
    .filter((line) => line.startsWith(DATA_FIELD))
    .map(stripDataPrefix)
    .join("\n");
  if (data === "") return SKIP;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    // One frame lost. Throwing would lose the rest of the answer too.
    return SKIP;
  }
}

function stripDataPrefix(line: string): string {
  const value = line.slice(DATA_FIELD.length);
  return value.startsWith(" ") ? value.slice(1) : value;
}

export interface SseStreamInit {
  body: unknown;
  signal?: AbortSignal;
}

/**
 * POSTs `body` as JSON and yields each event as it arrives.
 *
 * A refusal that happens before the first frame — 404 from a deployment
 * with no provider, 422 for a name that is no longer configured — is
 * still a normal HTTP error with the contract envelope, so it is thrown
 * carrying `data` in the shape `parseError` already reads from `$fetch`.
 * After the first frame there is no status code left, and the API reports
 * in band with an `error` event instead.
 */
export async function* openSseStream(url: string, init: SseStreamInit): AsyncGenerator<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(init.body),
    signal: init.signal,
  });

  if (!res.ok) throw await refusal(res);
  if (res.body === null) throw new Error(`AI stream response carried no body (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      // `stream: true` so a multi-byte character split across two chunks
      // is held rather than turned into a replacement character.
      buffered += decoder.decode(value, { stream: true });
      const decoded = decodeSseFrames(buffered);
      buffered = decoded.rest;
      for (const event of decoded.events) yield event;
    }
  } finally {
    // Reached when the consumer stops early — which is how cancelling
    // works. Without it the request stays open and the provider keeps
    // generating tokens that are billed and never read. Cancelling an
    // already-finished reader is a no-op; cancelling an aborted one can
    // reject, and there is nothing left to report it to.
    await reader.cancel().catch(() => undefined);
  }
}

async function refusal(res: Response): Promise<Error> {
  const error = new Error(`AI stream request failed with ${res.status}`);
  const text = await res.text().catch(() => "");
  try {
    return Object.assign(error, { data: JSON.parse(text) as unknown });
  } catch {
    // Not our envelope — a proxy's error page, most likely. The status is
    // all we can honestly report.
    return error;
  }
}
