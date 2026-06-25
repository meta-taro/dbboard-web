import { describe, expect, it, vi } from "vitest";
import { AiDisabledError, AiError, AiUpstreamError } from "../domain/ai/ai-error";
import {
  NO_AI_CAPABILITIES,
  type AiProvider,
  type AiResponse,
  type SuggestRequest,
} from "../domain/ai/ai-provider.port";
import { SuggestSql } from "./suggest-sql.use-case";

function makeProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    getId: () => "stub",
    getCapabilities: () => NO_AI_CAPABILITIES,
    explain: vi.fn(),
    suggestSql: vi.fn(),
    ...overrides,
  };
}

describe("SuggestSql", () => {
  it("throws AiDisabledError when no provider is configured", async () => {
    const useCase = new SuggestSql(undefined);
    await expect(useCase.execute({ prompt: "users by signup date" })).rejects.toBeInstanceOf(
      AiDisabledError,
    );
  });

  it("delegates to provider.suggestSql with the request verbatim", async () => {
    const response: AiResponse = { text: "SELECT * FROM users;", model: "claude-x" };
    const suggestSql = vi.fn().mockResolvedValue(response);
    const useCase = new SuggestSql(makeProvider({ suggestSql }));
    const request: SuggestRequest = { prompt: "all users", dialect: "postgres" };

    const result = await useCase.execute(request);

    expect(suggestSql).toHaveBeenCalledExactlyOnceWith(request);
    expect(result).toStrictEqual(response);
  });

  it("wraps a thrown AiError in AiUpstreamError with cause preserved", async () => {
    const cause = new AiError("upstream went sideways");
    const suggestSql = vi.fn().mockRejectedValue(cause);
    const useCase = new SuggestSql(makeProvider({ suggestSql }));

    const err = await useCase.execute({ prompt: "x" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiUpstreamError);
    expect((err as AiUpstreamError).cause).toBe(cause);
  });

  it("lets non-AiError throws bubble untouched (programming bugs, not upstream failures)", async () => {
    const bug = new TypeError("undefined.foo");
    const suggestSql = vi.fn().mockRejectedValue(bug);
    const useCase = new SuggestSql(makeProvider({ suggestSql }));

    await expect(useCase.execute({ prompt: "x" })).rejects.toBe(bug);
  });
});
