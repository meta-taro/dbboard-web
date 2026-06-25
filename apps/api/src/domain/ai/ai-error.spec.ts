import { describe, expect, it } from "vitest";
import { CategorizedError } from "../errors/categorized-error";
import { AiDisabledError, AiError, AiUpstreamError } from "./ai-error";

describe("AiError (adapter-internal)", () => {
  it("is a plain Error subclass, NOT a CategorizedError (no wire surface)", () => {
    const e = new AiError("boom");
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(CategorizedError);
    expect(e.name).toBe("AiError");
    expect(e.message).toBe("boom");
  });

  it("preserves the cause when passed", () => {
    const cause = new Error("upstream");
    const e = new AiError("boom", { cause });
    expect(e.cause).toBe(cause);
  });
});

describe("AiDisabledError (wire-mapped → 404)", () => {
  it("pins category to 'ai_disabled'", () => {
    expect(new AiDisabledError("AI disabled").category).toBe("ai_disabled");
  });

  it("is instanceof CategorizedError so ContractErrorFilter catches it", () => {
    expect(new AiDisabledError("x")).toBeInstanceOf(CategorizedError);
  });

  it("preserves the message verbatim (no category prefix)", () => {
    expect(new AiDisabledError("AI provider is not configured").message).toBe(
      "AI provider is not configured",
    );
  });

  it("preserves the subclass name for stack traces / logs", () => {
    expect(new AiDisabledError("x").name).toBe("AiDisabledError");
  });
});

describe("AiUpstreamError (wire-mapped → 502)", () => {
  it("pins category to 'ai_provider'", () => {
    expect(new AiUpstreamError("upstream failed").category).toBe("ai_provider");
  });

  it("is instanceof CategorizedError so ContractErrorFilter catches it", () => {
    expect(new AiUpstreamError("x")).toBeInstanceOf(CategorizedError);
  });

  it("preserves the cause when passed (so the adapter AiError survives the wrap)", () => {
    const cause = new AiError("underlying");
    const e = new AiUpstreamError("upstream failed", { cause });
    expect(e.cause).toBe(cause);
  });

  it("preserves the subclass name for stack traces / logs", () => {
    expect(new AiUpstreamError("x").name).toBe("AiUpstreamError");
  });
});
