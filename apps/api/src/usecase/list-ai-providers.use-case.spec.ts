import { describe, expect, it } from "vitest";
import { AiDisabledError } from "../domain/ai/ai-error";
import type {
  AiProviderDescriptor,
  AiProviderRegistry,
} from "../domain/ai/ai-provider-registry.port";
import { ListAiProviders } from "./list-ai-providers.use-case";

// The route-level view of these two cases lives in
// test/ai-routes.integration.spec.ts, which is where the 404 status is
// asserted. Here we pin the decision itself, one layer below the wire:
// an empty registry is a refusal, not an empty success.

function registryOf(providers: AiProviderDescriptor[]): AiProviderRegistry {
  return {
    list: () => providers,
    resolve: () => {
      throw new Error("resolve() is not part of this use case");
    },
  };
}

const TWO: AiProviderDescriptor[] = [
  { id: "fast", name: "Fast", kind: "anthropic", model: "claude-sonnet-4-6", default: false },
  { id: "deep", name: "Deep", kind: "anthropic", model: "claude-opus-4-8", default: true },
];

describe("ListAiProviders", () => {
  it("returns the registry's descriptors in the registry's order", () => {
    const useCase = new ListAiProviders(registryOf(TWO));
    expect(useCase.execute()).toEqual(TWO);
  });

  it("refuses an empty registry rather than returning an empty list", () => {
    const useCase = new ListAiProviders(registryOf([]));
    expect(() => useCase.execute()).toThrow(AiDisabledError);
  });
});
