import { describe, expect, it, vi } from "vitest";
import { AiError } from "../domain/ai/ai-error";
import {
  DEFAULT_OPENAI_BASE_URL,
  FetchOpenAiTransport,
  completionsUrl,
  decodeSseFrames,
  type FetchLike,
} from "./openai-transport";

const BODY = { model: "gpt-4o", messages: [{ role: "system" as const, content: "hi" }] };

function encodedStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function recordingFetch(reply: () => Response): {
  impl: FetchLike;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return reply();
  };
  return { impl, calls };
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

describe("completionsUrl", () => {
  it("appends the chat-completions path", () => {
    expect(completionsUrl("https://api.openai.com")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("does not double the separator when the base already ends in one", () => {
    expect(completionsUrl("https://gateway.example.com/openai//")).toBe(
      "https://gateway.example.com/openai/v1/chat/completions",
    );
  });
});

describe("decodeSseFrames", () => {
  it("returns each complete frame and keeps the unfinished tail", () => {
    expect(decodeSseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')).toEqual({
      frames: ['{"a":1}', '{"b":2}'],
      rest: 'data: {"c"',
    });
  });

  it("reassembles a frame split across two reads", () => {
    const first = decodeSseFrames('data: {"a":');
    expect(first.frames).toEqual([]);
    expect(decodeSseFrames(`${first.rest}1}\n\n`).frames).toEqual(['{"a":1}']);
  });

  it("ignores comments and fields that are not data", () => {
    expect(decodeSseFrames(": keep-alive\n\nevent: ping\nid: 7\n\ndata: x\n\n").frames).toEqual([
      "x",
    ]);
  });

  it("joins a multi-line data field with newlines, as the SSE spec says", () => {
    expect(decodeSseFrames("data: one\ndata: two\n\n").frames).toEqual(["one\ntwo"]);
  });

  it("handles CRLF line endings", () => {
    expect(decodeSseFrames('data: {"a":1}\r\n\r\n').frames).toEqual(['{"a":1}']);
  });

  it("passes the sentinel through untouched, for the provider to act on", () => {
    expect(decodeSseFrames("data: [DONE]\n\n").frames).toEqual(["[DONE]"]);
  });
});

describe("FetchOpenAiTransport construction", () => {
  it("defaults to the public API", () => {
    expect(DEFAULT_OPENAI_BASE_URL).toBe("https://api.openai.com");
  });

  it("refuses to send a key in the clear", () => {
    // Desktop pins `https_only(!is_localhost(base))` for the same reason:
    // a plaintext base URL puts the deployment's credential on the wire.
    expect(
      () => new FetchOpenAiTransport({ apiKey: "sk-test", baseUrl: "http://example.com" }),
    ).toThrow(AiError);
  });

  it("allows plaintext to a loopback address, which is how a local proxy is tested", () => {
    for (const base of ["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080"]) {
      expect(() => new FetchOpenAiTransport({ apiKey: "sk-test", baseUrl: base })).not.toThrow();
    }
  });

  it("rejects a base URL that is not a URL at all", () => {
    expect(() => new FetchOpenAiTransport({ apiKey: "sk-test", baseUrl: "not a url" })).toThrow(
      AiError,
    );
  });
});

describe("post", () => {
  it("sends the bearer credential and the JSON body", async () => {
    const { impl, calls } = recordingFetch(() => new Response("{}", { status: 200 }));
    const transport = new FetchOpenAiTransport({ apiKey: "sk-test", fetchImpl: impl });

    await transport.post(BODY);

    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].init?.method).toBe("POST");
    expect(headerOf(calls[0].init, "authorization")).toBe("Bearer sk-test");
    expect(headerOf(calls[0].init, "content-type")).toBe("application/json");
    expect(calls[0].init?.body).toBe(JSON.stringify(BODY));
  });

  it("hands back the status and the raw text, so the provider decides what they mean", async () => {
    const { impl } = recordingFetch(() => new Response("<html>nope</html>", { status: 502 }));
    const transport = new FetchOpenAiTransport({ apiKey: "sk-test", fetchImpl: impl });

    await expect(transport.post(BODY)).resolves.toEqual({
      status: 502,
      body: "<html>nope</html>",
    });
  });
});

describe("stream", () => {
  it("asks for an event stream and forwards the abort signal", async () => {
    const { impl, calls } = recordingFetch(
      () => new Response(encodedStream("data: [DONE]\n\n"), { status: 200 }),
    );
    const transport = new FetchOpenAiTransport({ apiKey: "sk-test", fetchImpl: impl });
    const controller = new AbortController();

    const opened = await transport.stream(BODY, { signal: controller.signal });
    expect(opened.ok).toBe(true);

    expect(headerOf(calls[0].init, "accept")).toBe("text/event-stream");
    expect(calls[0].init?.signal).toBe(controller.signal);
  });

  it("yields the payloads in order, across chunk boundaries", async () => {
    const { impl } = recordingFetch(
      () =>
        new Response(encodedStream('data: {"a"', ':1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n'), {
          status: 200,
        }),
    );
    const transport = new FetchOpenAiTransport({ apiKey: "sk-test", fetchImpl: impl });

    const opened = await transport.stream(BODY);
    if (!opened.ok) throw new Error("expected the stream to open");

    const seen: string[] = [];
    for await (const frame of opened.frames) seen.push(frame);
    expect(seen).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
  });

  it("reports a refusal as data rather than throwing, with the body intact", async () => {
    // The status arrives before any frame does, so this is still an
    // ordinary HTTP failure and the provider categorises it the same way
    // it categorises one from the atomic path.
    const { impl } = recordingFetch(
      () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    );
    const transport = new FetchOpenAiTransport({ apiKey: "sk-test", fetchImpl: impl });

    await expect(transport.stream(BODY)).resolves.toEqual({
      ok: false,
      status: 401,
      body: '{"error":{"message":"bad key"}}',
    });
  });

  it("cancels the response body when the consumer stops reading", async () => {
    const cancelled = vi.fn();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"a":1}\n\ndata: {"b":2}\n\n'));
      },
      cancel: cancelled,
    });
    const { impl } = recordingFetch(() => new Response(body, { status: 200 }));
    const transport = new FetchOpenAiTransport({ apiKey: "sk-test", fetchImpl: impl });

    const opened = await transport.stream(BODY);
    if (!opened.ok) throw new Error("expected the stream to open");
    for await (const _frame of opened.frames) break;

    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("treats a 200 with no body as an empty stream, not a failure", async () => {
    const { impl } = recordingFetch(() => new Response(null, { status: 204 }));
    const transport = new FetchOpenAiTransport({ apiKey: "sk-test", fetchImpl: impl });

    const opened = await transport.stream(BODY);
    if (!opened.ok) throw new Error("expected the stream to open");

    const seen: string[] = [];
    for await (const frame of opened.frames) seen.push(frame);
    expect(seen).toEqual([]);
  });
});
