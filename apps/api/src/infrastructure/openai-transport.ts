import { AiError } from "../domain/ai/ai-error";
import type { OpenAiChatRequest, OpenAiHttpResponse, OpenAiStreamOpen } from "./openai-provider";

// The only part of the OpenAI adapter that touches the network, split
// out from the provider so the provider's suite can run against three
// lines of stub and this file's suite can run against a stubbed `fetch`.
//
// Hand-rolled rather than `openai` from npm. Desktop hand-rolls the same
// wire (`crates/dbboard-openai` uses reqwest + serde, no SDK), the
// surface needed is one POST plus SSE decoding, and `CLAUDE.md` rule 4
// makes AI optional — an optional feature should not put a mandatory
// dependency in the tree. Baseline §12 wants that argument made before a
// package is added, and here it comes out against.

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";

/** The `fetch` seam, so a test never opens a socket. */
export type FetchLike = typeof globalThis.fetch;

export interface FetchOpenAiTransportOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
}

/**
 * Split an SSE buffer into complete frames and the unfinished tail.
 *
 * Pure, and separate from the reader loop, so a frame arriving in two
 * TCP reads is testable without a socket — the same shape the browser
 * half uses (`apps/web/app/composables/internal/sse.ts`).
 *
 * Only `data:` lines survive. OpenAI sends no `event:` names, but a
 * proxy in front of it may add comments or keep-alives, and those are
 * not payload.
 */
export function decodeSseFrames(buffer: string): { frames: string[]; rest: string } {
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  const frames: string[] = [];
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      // One optional space after the colon is the field separator, not
      // content; any further spaces are.
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    if (data !== "") frames.push(data);
  }
  return { frames, rest };
}

export class FetchOpenAiTransport {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: FetchOpenAiTransportOptions) {
    const baseUrl = options.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL;
    assertKeySafeToSend(baseUrl);
    this.url = completionsUrl(baseUrl);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async post(body: OpenAiChatRequest): Promise<OpenAiHttpResponse> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  }

  async stream(
    body: OpenAiChatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<OpenAiStreamOpen> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { ...this.headers(), accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    // A refusal arrives before any frame does, so it is still an ordinary
    // HTTP failure and travels back as data — the provider owns what a
    // status means, here and on the atomic path alike.
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, body: await response.text() };
    }
    return { ok: true, frames: readFrames(response.body) };
  }

  private headers(): Record<string, string> {
    return {
      // The one axis of the OpenAI wire that is purely transport:
      // `Authorization: Bearer`, where Anthropic takes `x-api-key` plus
      // an `anthropic-version` (ADR-0052).
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
  }
}

// Desktop pins `https_only(!is_localhost(base))` on the client it builds.
// Same rule: a plaintext base URL would put the deployment's credential
// on the wire, and the one case where that is deliberate rather than a
// mistake is a proxy on the same machine.
function assertKeySafeToSend(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (cause) {
    throw new AiError(`openai base url is not a url: ${baseUrl}`, {
      cause,
      category: "configuration",
    });
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) return;
  throw new AiError(
    `openai base url must be https unless it is loopback, got ${parsed.protocol}//${parsed.host}`,
    { category: "configuration" },
  );
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

async function* readFrames(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  // A 2xx with no body is an empty stream, not a failure — the provider
  // closes it the same way it closes one that ended without `[DONE]`.
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = decodeSseFrames(buffer);
      buffer = rest;
      for (const frame of frames) yield frame;
    }
  } finally {
    // A consumer that stops early closes the request rather than leaving
    // the provider generating tokens nobody reads (ADR-0026 Decision 5).
    await reader.cancel().catch(() => undefined);
  }
}
