import type { AiErrorCategory } from "../domain/ai/ai-error";

// How a provider's answer is reported, kept in one place for the same
// reason the prompts are: a history record must read the same whichever
// provider produced it. Each adapter still translates its own wire
// vocabulary — OpenAI's `finish_reason` is not Anthropic's `stop_reason`
// — but the vocabulary it translates *into* is defined here once.

// The history v:2 vocabulary (desktop brief 0008 § stop_reason).
// Anything outside it goes through the `other:<text>` escape hatch so
// the raw value stays legible instead of collapsing to null — providers
// add terminal reasons over time and this field is informational.
export const CANONICAL_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "refusal",
]);

export function normaliseStopReason(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  return CANONICAL_STOP_REASONS.has(raw) ? raw : `other:${raw}`;
}

// Null means "not reported". Never substitute a zero: in the history
// log a fabricated count is indistinguishable from a measured one.
export function tokenCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// 401/403 is the deployment's key being wrong or unentitled — filing
// that under `provider` would point an operator at a status page for a
// problem in their own environment.
export function categoriseStatus(status: number): AiErrorCategory {
  return status === 401 || status === 403 ? "configuration" : "provider";
}

// For providers whose failures arrive as thrown errors carrying an HTTP
// `status` (the Anthropic SDK's typed errors). A failure with no status
// never reached a server, so it is the network's.
export function categoriseUpstream(cause: unknown): AiErrorCategory {
  const status =
    typeof cause === "object" && cause !== null && "status" in cause
      ? (cause as { status: unknown }).status
      : undefined;
  if (typeof status !== "number") {
    return "network";
  }
  return categoriseStatus(status);
}
