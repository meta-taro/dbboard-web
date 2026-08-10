import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Response } from "express";
import { AiError, AiUpstreamError } from "../domain/ai/ai-error";
import type { StreamEvent } from "../domain/ai/ai-provider.port";
import { pipeAiStream } from "./ai-sse";

// Same stand-in as connection-dump.controller.spec.ts, narrowed to what
// SSE needs: headers, writes, and the `close` that says the browser tab
// went away mid-answer.
class FakeResponse extends EventEmitter {
  readonly headers: Record<string, string> = {};
  readonly chunks: string[] = [];
  writableEnded = false;
  destroyed = false;
  /** 1-based index of the write after which the client vanishes. */
  closeAfter: number | null = null;

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (this.closeAfter !== null && this.chunks.length >= this.closeAfter) {
      this.destroyed = true;
      this.emit("close");
    }
    return true;
  }

  end(): void {
    this.writableEnded = true;
  }

  get body(): string {
    return this.chunks.join("");
  }
}

function response(): { res: Response; fake: FakeResponse } {
  const fake = new FakeResponse();
  return { res: fake as unknown as Response, fake };
}

// Parses the framing back out, so the assertions can talk about events
// rather than about string concatenation.
function parse(body: string): unknown[] {
  return body
    .split("\n\n")
    .filter((frame) => frame !== "")
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as unknown);
}

const EVENTS: StreamEvent[] = [
  { type: "message_start", tokensIn: 11, model: "claude-served" },
  { type: "text_delta", text: "It reads " },
  { type: "text_delta", text: "one row." },
  { type: "usage", tokensIn: 11, tokensOut: 4 },
  { type: "message_stop", stopReason: "end_turn" },
];

interface Source {
  events: AsyncIterable<StreamEvent>;
  /** Set by the generator's `finally` — proves it was torn down. */
  closed: () => boolean;
  produced: () => number;
}

function source(items: StreamEvent[], failure?: unknown): Source {
  let closed = false;
  let produced = 0;
  async function* generate(): AsyncGenerator<StreamEvent> {
    try {
      for (const item of items) {
        produced += 1;
        yield item;
      }
      if (failure) throw failure;
    } finally {
      closed = true;
    }
  }
  return { events: generate(), closed: () => closed, produced: () => produced };
}

describe("pipeAiStream", () => {
  it("declares an unbuffered event stream before writing anything", async () => {
    const { res, fake } = response();

    await pipeAiStream(res, source([]).events);

    expect(fake.headers["Content-Type"]).toBe("text/event-stream; charset=utf-8");
    expect(fake.headers["Cache-Control"]).toBe("no-cache, no-transform");
    // Without this a reverse proxy holds every delta until the response
    // ends, which is the one thing streaming exists to avoid.
    expect(fake.headers["X-Accel-Buffering"]).toBe("no");
  });

  it("frames each event as an unnamed data line and ends the response", async () => {
    const { res, fake } = response();

    await pipeAiStream(res, source(EVENTS).events);

    // No `event:` names: the type is inside the payload, so a client
    // parses one shape instead of registering five listeners.
    expect(fake.body.includes("event:")).toBe(false);
    expect(fake.chunks.every((chunk) => chunk.startsWith("data: ") && chunk.endsWith("\n\n"))).toBe(
      true,
    );
    expect(parse(fake.body)).toStrictEqual(EVENTS);
    expect(fake.writableEnded).toBe(true);
  });

  it("keeps multi-line text on one data line", async () => {
    const { res, fake } = response();

    await pipeAiStream(res, source([{ type: "text_delta", text: "one\ntwo" }]).events);

    // A raw newline would end the SSE frame early and split the event in
    // two; JSON escaping is what keeps that from happening.
    expect(fake.body).toBe(`data: {"type":"text_delta","text":"one\\ntwo"}\n\n`);
  });

  it("reports a mid-stream failure in band, because the 200 is already gone", async () => {
    const { res, fake } = response();
    const failure = new AiUpstreamError("Anthropic stream failed", {
      cause: new AiError("overloaded", { category: "provider" }),
    });

    await pipeAiStream(res, source([EVENTS[1]], failure).events);

    expect(parse(fake.body)).toStrictEqual([
      EVENTS[1],
      { type: "error", category: "provider", message: "overloaded" },
    ]);
    expect(fake.writableEnded).toBe(true);
  });

  it("carries the underlying category rather than flattening every failure to one", async () => {
    const { res, fake } = response();
    const failure = new AiUpstreamError("key rejected", {
      cause: new AiError("invalid x-api-key", { category: "configuration" }),
    });

    await pipeAiStream(res, source([], failure).events);

    expect(parse(fake.body)).toStrictEqual([
      { type: "error", category: "configuration", message: "invalid x-api-key" },
    ]);
  });

  it("does not put an internal error's text on the wire", async () => {
    const { res, fake } = response();

    await pipeAiStream(res, source([], new TypeError("cannot read foo of undefined")).events);

    // A bug in our own code is not an AI outcome and its message is not
    // the client's business — the connection still has to be told the
    // answer is not coming.
    expect(parse(fake.body)).toStrictEqual([
      { type: "error", category: "provider", message: "AI stream failed" },
    ]);
    expect(fake.writableEnded).toBe(true);
  });

  it("tears the source down when the client hangs up, rather than reading it to the end", async () => {
    const { res, fake } = response();
    fake.closeAfter = 2;
    const src = source(EVENTS);

    await pipeAiStream(res, src.events);

    // Two events written, and the generator's `finally` ran — that is
    // what stops the upstream request and writes the cancelled record.
    expect(fake.chunks).toHaveLength(2);
    expect(src.closed()).toBe(true);
    expect(src.produced()).toBeLessThan(EVENTS.length);
    // Nothing more is written to a socket nobody is holding, and the
    // response is not "ended" — it was severed.
    expect(fake.writableEnded).toBe(false);
  });

  it("writes nothing at all when the client is already gone", async () => {
    const { res, fake } = response();
    fake.destroyed = true;
    const src = source(EVENTS);

    await pipeAiStream(res, src.events);

    expect(fake.chunks).toStrictEqual([]);
    expect(src.produced()).toBe(0);
  });
});
