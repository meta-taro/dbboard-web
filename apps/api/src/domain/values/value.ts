// A cell value, matching docs/api-contract.md § Value. Most variants map to a
// plain JSON scalar. Two need a tag: JSON has no native byte type, and a bare
// tree would be indistinguishable from a string that happens to look like JSON.

export interface BlobValue {
  $blob: string;
}

// The payload of a `$json` cell. Deliberately a plain JSON tree and not a
// nested `Value`: the contract calls the payload opaque, so a document that
// holds a "$blob" key is that document, not a blob. Typing it as `Value`
// would invite consumers to walk in looking for tags.
export type JsonPayload =
  | null
  | boolean
  | number
  | string
  | JsonPayload[]
  | { [key: string]: JsonPayload };

export interface JsonValue {
  $json: JsonPayload;
}

export type Value = null | number | string | BlobValue | JsonValue;

// docs/api-contract.md pins the standard alphabet (+/=). Buffer.from base64
// is permissive on input (accepts url-safe), so the writer uses base64 and
// the reader uses base64 — we never round-trip through url-safe.
export function encodeBlob(bytes: Uint8Array): BlobValue {
  return { $blob: Buffer.from(bytes).toString("base64") };
}

export function decodeBlob(value: BlobValue): Uint8Array {
  return new Uint8Array(Buffer.from(value.$blob, "base64"));
}

// The contract says: "The `$blob` object must have exactly that one key;
// any other or extra key is a malformed value."
export function isBlobValue(value: unknown): value is BlobValue {
  if (value === null || typeof value !== "object") return false;
  const keys = Object.keys(value as object);
  if (keys.length !== 1 || keys[0] !== "$blob") return false;
  return typeof (value as { $blob: unknown }).$blob === "string";
}

// Same exactly-one-key rule as `$blob`. The payload itself is unconstrained —
// "The payload may be any JSON, including `null`" — so the only thing to reject
// beyond the key shape is a key present with no value at all, which is not a
// JSON document and would vanish on the way back out through JSON.stringify.
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value !== "object") return false;
  const keys = Object.keys(value as object);
  if (keys.length !== 1 || keys[0] !== "$json") return false;
  return (value as { $json: unknown }).$json !== undefined;
}
