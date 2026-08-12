import { describe, expect, it } from "vitest";
import { decodeBlob, encodeBlob, isBlobValue, isJsonValue } from "./value";

describe("value", () => {
  describe("encodeBlob / decodeBlob", () => {
    it("round-trips an empty payload", () => {
      const empty = new Uint8Array(0);
      const encoded = encodeBlob(empty);
      expect(encoded).toEqual({ $blob: "" });
      expect(decodeBlob(encoded)).toEqual(empty);
    });

    it("uses the standard base64 alphabet (RFC 4648, +/= padding)", () => {
      // docs/api-contract.md pins the alphabet — url-safe (-/_) would be a
      // contract drift, caught here.
      const bytes = new Uint8Array([0xff, 0xff, 0xfe]);
      const encoded = encodeBlob(bytes);
      expect(encoded.$blob).toBe("///+");
      expect(decodeBlob(encoded)).toEqual(bytes);
    });

    it("matches the docs/api-contract.md sample (bytes [0, 255] -> AP8=)", () => {
      const sample = new Uint8Array([0, 255]);
      expect(encodeBlob(sample)).toEqual({ $blob: "AP8=" });
      expect(decodeBlob({ $blob: "AP8=" })).toEqual(sample);
    });
  });

  describe("isBlobValue", () => {
    it("narrows the {$blob:string} shape", () => {
      expect(isBlobValue({ $blob: "AA==" })).toBe(true);
    });

    it("rejects extra keys (contract requires exactly $blob)", () => {
      expect(isBlobValue({ $blob: "AA==", extra: 1 })).toBe(false);
    });

    it("rejects non-string $blob payloads", () => {
      expect(isBlobValue({ $blob: 0 })).toBe(false);
      expect(isBlobValue({ $blob: null })).toBe(false);
    });

    it("rejects scalars", () => {
      expect(isBlobValue(null)).toBe(false);
      expect(isBlobValue(0)).toBe(false);
      expect(isBlobValue("AA==")).toBe(false);
      expect(isBlobValue(undefined)).toBe(false);
    });

    // The contract calls the $json payload opaque: a document that happens to
    // hold a "$blob" key is that document. Nothing may walk into the tree
    // looking for tags, so the outer value is never a blob.
    it("rejects a $json document, even one whose payload holds a $blob key", () => {
      expect(isBlobValue({ $json: { $blob: "AA==" } })).toBe(false);
    });
  });

  describe("isJsonValue", () => {
    it("narrows the {$json:<any JSON>} shape", () => {
      expect(isJsonValue({ $json: { a: [1, 2] } })).toBe(true);
    });

    // Every JSON type is a legal payload — the tag says "a document lives
    // here", not "an object lives here".
    it("accepts any JSON payload, scalars included", () => {
      expect(isJsonValue({ $json: [1, 2] })).toBe(true);
      expect(isJsonValue({ $json: "text" })).toBe(true);
      expect(isJsonValue({ $json: 0 })).toBe(true);
      expect(isJsonValue({ $json: false })).toBe(true);
    });

    // "{ $json: null } is a document whose content is JSON null; it is not a
    // SQL NULL, which is encoded as bare null." Conflating the two loses the
    // difference between an empty column and a null document.
    it("accepts a null payload, which is not the same value as SQL NULL", () => {
      expect(isJsonValue({ $json: null })).toBe(true);
      expect(isJsonValue(null)).toBe(false);
    });

    it("rejects extra keys (contract requires exactly $json)", () => {
      expect(isJsonValue({ $json: 1, extra: 1 })).toBe(false);
    });

    it("rejects the other tag and bare scalars", () => {
      expect(isJsonValue({ $blob: "AA==" })).toBe(false);
      expect(isJsonValue(0)).toBe(false);
      expect(isJsonValue("{}")).toBe(false);
      expect(isJsonValue(undefined)).toBe(false);
    });

    // A missing key and a present key holding undefined are different objects
    // in JS but the same after JSON.stringify — the tag must not survive a
    // round-trip as a key with no value.
    it("rejects a $json key holding undefined", () => {
      expect(isJsonValue({ $json: undefined })).toBe(false);
    });
  });
});
