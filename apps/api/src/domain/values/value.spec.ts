import { describe, expect, it } from "vitest";
import { decodeBlob, encodeBlob, isBlobValue } from "./value";

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
  });
});
