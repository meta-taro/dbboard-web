import { QUERY_BODY_LIMIT_BYTES } from "../domain/limits";

// Seam for the per-request body cap. The canonical value lives in
// domain/limits.ts (QUERY_BODY_LIMIT_BYTES = 64 KiB, pinned by
// docs/api-contract.md). DBBOARD_API_MAX_BODY_BYTES is a local
// experimentation override only — do not commit non-contract values.
export const MAX_BODY_BYTES = Number.parseInt(
  process.env.DBBOARD_API_MAX_BODY_BYTES ?? `${QUERY_BODY_LIMIT_BYTES}`,
  10,
);

// Loopback bind by default — issue 0016. LAN exposure is opt-in via
// DBBOARD_BIND_HOST and requires DBBOARD_API_SECRET (enforced by
// assertSafeBindConfig). Empty-string env values fall back to the safe
// default so a placeholder `DBBOARD_BIND_HOST=` line in .env never
// silently exposes the API.
const rawBindHost = process.env.DBBOARD_BIND_HOST;
export const BIND_HOST: string =
  rawBindHost !== undefined && rawBindHost.length > 0 ? rawBindHost : "127.0.0.1";

const rawApiSecret = process.env.DBBOARD_API_SECRET;
export const API_SECRET: string | undefined =
  rawApiSecret !== undefined && rawApiSecret.length > 0 ? rawApiSecret : undefined;

// The AI provider config used to live here as two exports, read at
// import time. Ticket 0032 slice B moved it to
// bootstrap/ai-providers.config.ts, because a list of providers cannot
// be read once at import: the reader now takes the environment as an
// argument, which is also what lets its tests describe one environment
// per case instead of resetting modules around each one.
//
// `DBBOARD_ANTHROPIC_API_KEY` / `DBBOARD_ANTHROPIC_MODEL` still work
// unchanged — they became the first entry of the list rather than a
// special case. Their behaviour (blank means unset, and the model
// default) is asserted in ai-providers.config.spec.ts.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export interface BindConfig {
  bindHost: string;
  apiSecret: string | undefined;
}

export function assertSafeBindConfig({ bindHost, apiSecret }: BindConfig): void {
  if (isLoopbackHost(bindHost)) return;
  if (apiSecret === undefined) {
    throw new Error(
      `Refusing to bind to ${bindHost} without DBBOARD_API_SECRET set. ` +
        `Either set DBBOARD_BIND_HOST=127.0.0.1 (loopback only) or configure ` +
        `DBBOARD_API_SECRET so the bearer-auth middleware can gate the exposed port.`,
    );
  }
}
