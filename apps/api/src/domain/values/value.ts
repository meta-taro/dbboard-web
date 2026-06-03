// A cell value, matching docs/api-contract.md § Value. JSON has no native
// byte type, so blobs use the tagged `{ $blob: <base64> }` shape; every
// other variant maps to a plain JSON scalar.

export interface BlobValue {
  $blob: string;
}

export type Value = null | number | string | BlobValue;

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
