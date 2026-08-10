// Ticket 0032 slice B — the provider list, read from the environment.
//
// Desktop keeps this in `ai-providers.toml` next to the OS keychain
// (ADR-0025 Decisions 1–2). Web has neither: a server has no keychain,
// and accepting a key over HTTP would put credential writing behind a
// bearer token, which baseline §15 reserves for the operator. So the
// list is env-only, and the operator who could edit the TOML on desktop
// is the operator who sets the variables here.
//
// What is mirrored from ADR-0025 is the parse posture rather than the
// syntax: a duplicate id, an unknown kind and a default that names
// nothing are hard errors. A misconfigured provider must not boot as a
// deployment silently missing one — the operator would find out from a
// user, not from the startup log.

// The kinds this build can construct. Slice D adds "openai"; adding a
// row here without adding one to the factory in app.module.ts is a
// compile error there, which is the point of keeping it a union.
const KNOWN_KINDS = ["anthropic"] as const;
export type AiProviderKind = (typeof KNOWN_KINDS)[number];

const DEFAULT_MODEL_BY_KIND: Record<AiProviderKind, string> = {
  anthropic: "claude-sonnet-4-6",
};

export interface AiProviderConfigEntry {
  id: string;
  name: string;
  kind: AiProviderKind;
  model: string;
  apiKey: string;
}

export interface AiProvidersConfig {
  entries: AiProviderConfigEntry[];
  // `undefined` only when there are no entries at all.
  defaultId: string | undefined;
}

// The environment as this module needs it. Taking it as an argument
// rather than reading `process.env` at import time keeps the reader a
// pure function, which is what lets its tests describe one environment
// per case instead of resetting modules around each one.
export type Env = Record<string, string | undefined>;

// The legacy Stage 1 block. It becomes an ordinary entry rather than a
// special case, so a deployment that only sets these two variables gets
// a one-entry registry that behaves exactly as the single provider did.
const LEGACY_ID = "anthropic";

// Restricting ids to this alphabet is what makes the id → variable
// suffix mapping injective: `_` cannot appear in an id, so replacing `-`
// with `_` can never make two different ids collide on one variable.
const ID_PATTERN = /^[a-z0-9-]+$/;

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function suffixOf(id: string): string {
  return id.toUpperCase().replace(/-/g, "_");
}

function isKnownKind(kind: string): kind is AiProviderKind {
  return (KNOWN_KINDS as readonly string[]).includes(kind);
}

function readLegacyEntry(env: Env): AiProviderConfigEntry | undefined {
  const apiKey = nonEmpty(env.DBBOARD_ANTHROPIC_API_KEY);
  if (apiKey === undefined) return undefined;
  return {
    id: LEGACY_ID,
    name: LEGACY_ID,
    kind: "anthropic",
    model: nonEmpty(env.DBBOARD_ANTHROPIC_MODEL) ?? DEFAULT_MODEL_BY_KIND.anthropic,
    apiKey,
  };
}

function readListedEntry(env: Env, id: string): AiProviderConfigEntry {
  if (!ID_PATTERN.test(id)) {
    throw new Error(
      `DBBOARD_AI_PROVIDERS lists "${id}", which is not a valid provider id — use lowercase letters, digits and hyphens only`,
    );
  }
  const suffix = suffixOf(id);
  const kind = nonEmpty(env[`DBBOARD_AI_${suffix}_KIND`]);
  if (kind === undefined) {
    throw new Error(`DBBOARD_AI_${suffix}_KIND is not set, but "${id}" is listed as a provider`);
  }
  if (!isKnownKind(kind)) {
    throw new Error(
      `DBBOARD_AI_${suffix}_KIND is "${kind}", which this build cannot construct — "${id}" must be one of: ${KNOWN_KINDS.join(", ")}`,
    );
  }
  const apiKey = nonEmpty(env[`DBBOARD_AI_${suffix}_API_KEY`]);
  if (apiKey === undefined) {
    throw new Error(`DBBOARD_AI_${suffix}_API_KEY is not set, but "${id}" is listed as a provider`);
  }
  return {
    id,
    name: nonEmpty(env[`DBBOARD_AI_${suffix}_NAME`]) ?? id,
    kind,
    model: nonEmpty(env[`DBBOARD_AI_${suffix}_MODEL`]) ?? DEFAULT_MODEL_BY_KIND[kind],
    apiKey,
  };
}

export function readAiProvidersConfig(env: Env): AiProvidersConfig {
  const entries: AiProviderConfigEntry[] = [];

  // The legacy entry goes first so that a deployment adding a list to an
  // existing key keeps the same default it had yesterday.
  const legacy = readLegacyEntry(env);
  if (legacy !== undefined) entries.push(legacy);

  const listed = (env.DBBOARD_AI_PROVIDERS ?? "")
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  for (const id of listed) {
    if (entries.some((entry) => entry.id === id)) {
      throw new Error(
        `duplicate AI provider id "${id}" — each provider must be listed once, and "${LEGACY_ID}" is taken by DBBOARD_ANTHROPIC_API_KEY when that is set`,
      );
    }
    entries.push(readListedEntry(env, id));
  }

  const requestedDefault = nonEmpty(env.DBBOARD_AI_DEFAULT);
  if (requestedDefault !== undefined && !entries.some((entry) => entry.id === requestedDefault)) {
    throw new Error(
      `DBBOARD_AI_DEFAULT is "${requestedDefault}", which is not a configured provider`,
    );
  }

  return {
    entries,
    defaultId: requestedDefault ?? entries[0]?.id,
  };
}
