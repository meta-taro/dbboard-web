import { describe, expect, it, vi } from "vitest";
import { AiDisabledError, AiError, AiUpstreamError } from "../domain/ai/ai-error";
import {
  NO_AI_CAPABILITIES,
  type AiProvider,
  type AiResponse,
  type ExplainRequest,
} from "../domain/ai/ai-provider.port";
import { ExplainSql } from "./explain-sql.use-case";

function makeProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    getId: () => "stub",
    getCapabilities: () => NO_AI_CAPABILITIES,
    explain: vi.fn(),
    suggestSql: vi.fn(),
    ...overrides,
  };
}

describe("ExplainSql", () => {
  it("throws AiDisabledError when no provider is configured", async () => {
    const useCase = new ExplainSql(undefined);
    await expect(useCase.execute({ sql: "SELECT 1" })).rejects.toBeInstanceOf(AiDisabledError);
  });

  it("delegates to provider.explain with the request verbatim", async () => {
    const response: AiResponse = { text: "explanation", model: "claude-x" };
    const explain = vi.fn().mockResolvedValue(response);
    const useCase = new ExplainSql(makeProvider({ explain }));
    const request: ExplainRequest = { sql: "SELECT 1", dialect: "postgres" };

    const result = await useCase.execute(request);

    expect(explain).toHaveBeenCalledExactlyOnceWith(request);
    expect(result).toStrictEqual(response);
  });

  it("wraps a thrown AiError in AiUpstreamError with cause preserved", async () => {
    const cause = new AiError("upstream went sideways");
    const explain = vi.fn().mockRejectedValue(cause);
    const useCase = new ExplainSql(makeProvider({ explain }));

    const err = await useCase.execute({ sql: "SELECT 1" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiUpstreamError);
    expect((err as AiUpstreamError).cause).toBe(cause);
  });

  it("lets non-AiError throws bubble untouched (programming bugs, not upstream failures)", async () => {
    const bug = new TypeError("undefined.foo");
    const explain = vi.fn().mockRejectedValue(bug);
    const useCase = new ExplainSql(makeProvider({ explain }));

    await expect(useCase.execute({ sql: "SELECT 1" })).rejects.toBe(bug);
  });
});
