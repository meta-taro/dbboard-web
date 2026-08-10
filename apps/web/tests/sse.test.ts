import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSseFrames, openSseStream } from "../app/composables/internal/sse";

function bodyOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function okResponse(chunks: readonly string[]): unknown {
  return { ok: true, status: 200, body: bodyOf(chunks) };
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decodeSseFrames", () => {
  it("returns nothing for an empty buffer", () => {
    expect(decodeSseFrames("")).toEqual({ events: [], rest: "" });
  });

  it("decodes one complete frame and leaves no remainder", () => {
    expect(decodeSseFrames('data: {"type":"text_delta","text":"hi"}\n\n')).toEqual({
      events: [{ type: "text_delta", text: "hi" }],
      rest: "",
    });
  });

  it("decodes several frames in arrival order", () => {
    const buffered = 'data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\n';
    expect(decodeSseFrames(buffered).events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("holds back a frame that has not finished arriving", () => {
    const result = decodeSseFrames('data: {"n":1}\n\ndata: {"n":2}');
    expect(result.events).toEqual([{ n: 1 }]);
    expect(result.rest).toBe('data: {"n":2}');
  });

  it("reassembles a frame split across two chunk boundaries", () => {
    // The transport may split anywhere, including mid-token. Feeding the
    // previous remainder back in is the whole contract of `rest`.
    const first = decodeSseFrames('data: {"type":"text_del');
    expect(first.events).toEqual([]);
    const second = decodeSseFrames(first.rest + 'ta","text":"hi"}\n\n');
    expect(second.events).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(second.rest).toBe("");
  });

  it("accepts CRLF frame separators", () => {
    expect(decodeSseFrames('data: {"n":1}\r\n\r\ndata: {"n":2}\r\n\r\n').events).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
  });

  it("ignores comment lines used as heartbeats", () => {
    expect(decodeSseFrames(': ping\n\ndata: {"n":1}\n\n').events).toEqual([{ n: 1 }]);
  });

  it("ignores fields other than data", () => {
    expect(decodeSseFrames('event: message\nid: 7\ndata: {"n":1}\n\n').events).toEqual([{ n: 1 }]);
  });

  it("joins multi-line data with newlines, per the SSE grammar", () => {
    expect(decodeSseFrames('data: {"n":\ndata: 1}\n\n').events).toEqual([{ n: 1 }]);
  });

  it("accepts a data line with no space after the colon", () => {
    expect(decodeSseFrames('data:{"n":1}\n\n').events).toEqual([{ n: 1 }]);
  });

  it("skips a frame whose data is not JSON rather than throwing", () => {
    // A frame we cannot read is one event lost; throwing would lose the
    // rest of the answer too.
    expect(decodeSseFrames('data: not json\n\ndata: {"n":1}\n\n').events).toEqual([{ n: 1 }]);
  });

  it("skips a frame carrying no data field at all", () => {
    expect(decodeSseFrames("event: message\n\n").events).toEqual([]);
  });
});

describe("openSseStream", () => {
  it("posts a JSON body and yields the decoded events in order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(['data: {"n":1}\n\ndata: {"n":2}\n\n']));
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(
      openSseStream("/ai/explain/stream", { body: { sql: "SELECT 1" } }),
    );

    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("/ai/explain/stream");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ sql: "SELECT 1" }));
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("yields events that arrived in separate network chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse(['data: {"n":1}\n', "\ndata: ", '{"n":2}\n\n'])),
    );

    expect(await collect(openSseStream("/x", { body: {} }))).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("forwards the caller's abort signal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await collect(openSseStream("/x", { body: {}, signal: controller.signal }));

    const [, init] = fetchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(init.signal).toBe(controller.signal);
  });

  it("throws the refusal envelope so parseError can categorise it", async () => {
    // A disabled deployment answers 404 with the contract envelope before
    // any frame is written — the panel must show the same banner it shows
    // for the atomic route.
    const envelope = { error: { category: "ai_disabled", message: "AI is not configured" } };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve(JSON.stringify(envelope)),
      }),
    );

    await expect(collect(openSseStream("/x", { body: {} }))).rejects.toMatchObject({
      data: envelope,
    });
  });

  it("throws a plain error when a refusal body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.resolve("<html>gateway</html>"),
      }),
    );

    await expect(collect(openSseStream("/x", { body: {} }))).rejects.toThrow("502");
  });

  it("throws when the response carries no body to read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }));

    await expect(collect(openSseStream("/x", { body: {} }))).rejects.toThrow(/body/i);
  });

  it("cancels the reader when the consumer stops early", async () => {
    // Abandoning the loop is how the panel cancels; it has to reach the
    // socket, or the provider keeps generating billed tokens nobody reads.
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi
        .fn()
        .mockResolvedValue({ done: false, value: new TextEncoder().encode('data: {"n":1}\n\n') }),
      cancel,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: { getReader: () => reader } }),
    );

    for await (const _event of openSseStream("/x", { body: {} })) break;

    expect(cancel).toHaveBeenCalled();
  });
});
