import type { Response } from "express";
import { AiError, type AiErrorCategory } from "../domain/ai/ai-error";
import type { StreamEvent } from "../domain/ai/ai-provider.port";

// The wire boundary for AI streaming: `StreamEvent` values, one per
// server-sent event, JSON in the `data` field and nothing else.
//
// No `event:` names. The type is already inside the payload, so naming
// the frames too would give a client two vocabularies to keep in step
// and force it to register a listener per variant — including the ones
// added later, which it would then silently drop.
//
// This is also the only place a failure can be reported *in band*. Once
// the 200 has gone out there is no status code left, and the exception
// filter's envelope would arrive as a body the client is not parsing —
// which is why the port carries an `error` variant that no provider ever
// emits. Resolution failures do not reach here at all: the use case
// resolves synchronously, before the controller touches the response.

// Same fallback as `mapAiError` in record-history.use-case.ts: the call
// failed somewhere past our boundary and nothing has proven otherwise.
const FALLBACK_CATEGORY: AiErrorCategory = "provider";

const CLIENT_GONE = Symbol("client gone");

export async function pipeAiStream(
  res: Response,
  events: AsyncIterable<StreamEvent>,
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Reverse proxies buffer responses by default, which would hold every
  // delta back until the answer finished — the exact thing streaming
  // exists to avoid. nginx reads this header; others ignore it harmlessly.
  res.setHeader("X-Accel-Buffering", "no");

  // Driven by hand rather than with `for await` so the wait for the next
  // event can be raced against the client leaving. `for await` can only
  // notice a hangup *after* the next event arrives, which on a stalled
  // upstream is never — the request would stay open, and billed, with
  // nobody listening.
  const iterator = events[Symbol.asyncIterator]();
  const gone = clientGone(res);

  try {
    for (;;) {
      if (isGone(res)) return await stop(iterator);
      const step = await Promise.race([iterator.next(), gone]);
      if (step === CLIENT_GONE) return await stop(iterator);
      if (step.done === true) break;
      if (isGone(res)) return await stop(iterator);
      // No `drain` handling, unlike the dump route: an answer is capped
      // at the adapter's max_tokens, so the whole stream fits in a socket
      // buffer many times over. A dump has no such ceiling.
      res.write(frame(step.value));
    }
  } catch (err: unknown) {
    // Deliberately not rethrown. Nest's exception filter would try to
    // send an envelope over a response whose headers are long gone,
    // turning a reportable failure into a stack trace about headers.
    if (!isGone(res)) res.write(frame(errorEvent(err)));
  }

  if (!isGone(res)) res.end();
}

function frame(event: StreamEvent): string {
  // JSON is what keeps a newline inside a delta from ending the frame
  // early and splitting one event into two unparseable halves.
  return `data: ${JSON.stringify(event)}\n\n`;
}

function errorEvent(err: unknown): StreamEvent {
  const ai = asAiError(err);
  return ai
    ? { type: "error", category: ai.category, message: ai.message }
    : // A bug in our own code: the client is told the answer is not
      // coming, but not what broke — an internal message is not part of
      // the contract and may name internals.
      { type: "error", category: FALLBACK_CATEGORY, message: "AI stream failed" };
}

// The use case wraps the adapter's AiError in AiUpstreamError, so the
// category that was measured at the transport lives one level down.
function asAiError(err: unknown): AiError | null {
  if (err instanceof AiError) return err;
  if (err instanceof Error && err.cause instanceof AiError) return err.cause;
  return null;
}

function isGone(res: Response): boolean {
  return res.writableEnded || res.destroyed;
}

// Ends the generator at its suspension point, which runs its `finally`
// — that is what aborts the upstream request and writes the cancelled
// history record.
async function stop(iterator: AsyncIterator<StreamEvent>): Promise<void> {
  await iterator.return?.(undefined);
}

function clientGone(res: Response): Promise<typeof CLIENT_GONE> {
  return new Promise((resolve) => {
    if (isGone(res)) {
      resolve(CLIENT_GONE);
      return;
    }
    res.once("close", () => resolve(CLIENT_GONE));
  });
}
