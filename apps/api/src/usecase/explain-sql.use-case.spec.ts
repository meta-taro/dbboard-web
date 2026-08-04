import { describe, expect, it, vi } from "vitest";
import { AiDisabledError, AiError, AiUpstreamError } from "../domain/ai/ai-error";
import {
  NO_AI_CAPABILITIES,
  type AiProvider,
  type AiResponse,
  type ExplainRequest,
} from "../domain/ai/ai-provider.port";
import { ExplainSql } from "./explain-sql.use-case";
import { RecordHistory } from "./record-history.use-case";

// The recording behaviour these two use cases share is covered once, in
// record-ai-call.spec.ts. What is specific to ExplainSql — and therefore
// tested here — is the delegation seam: which provider method it calls
// and what it treats as the prompt.

function makeProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    getId: () => "stub",
    getModel: () => "claude-configured",
    getCapabilities: () => NO_AI_CAPABILITIES,
    explain: vi.fn(),
    suggestSql: vi.fn(),
    ...overrides,
  };
}

function makeHistory(): { history: RecordHistory; recordAiSuccess: ReturnType<typeof vi.fn> } {
  const history = new RecordHistory({
    record: () => Promise.resolve(),
    // eslint-disable-next-line require-yield
    iterate: async function* () {
      throw new Error("not used in these tests");
    },
  });
  const recordAiSuccess = vi.spyOn(history, "recordAiSuccess") as unknown as ReturnType<
    typeof vi.fn
  >;
  return { history, recordAiSuccess };
}

const RESPONSE: AiResponse = {
  text: "explanation",
  model: "claude-x",
  tokensIn: 10,
  tokensOut: 20,
  stopReason: "end_turn",
};

describe("ExplainSql", () => {
  it("throws AiDisabledError when no provider is configured", async () => {
    const { history } = makeHistory();
    const useCase = new ExplainSql(undefined, history);
    await expect(useCase.execute({ sql: "SELECT 1" })).rejects.toBeInstanceOf(AiDisabledError);
  });

  it("delegates to provider.explain with the request verbatim", async () => {
    const { history } = makeHistory();
    const explain = vi.fn().mockResolvedValue(RESPONSE);
    const useCase = new ExplainSql(makeProvider({ explain }), history);
    const request: ExplainRequest = { sql: "SELECT 1", dialect: "postgres" };

    const result = await useCase.execute(request);

    expect(explain).toHaveBeenCalledExactlyOnceWith(request);
    expect(result).toStrictEqual(RESPONSE);
  });

  it("records the explain intent with the SQL as the prompt", async () => {
    const { history, recordAiSuccess } = makeHistory();
    const explain = vi.fn().mockResolvedValue(RESPONSE);
    const useCase = new ExplainSql(makeProvider({ explain }), history);

    await useCase.execute({ sql: "SELECT * FROM users" });

    expect(recordAiSuccess).toHaveBeenCalledOnce();
    // For an explain, the SQL under discussion *is* the prompt.
    expect(recordAiSuccess.mock.calls[0][0]).toMatchObject({
      intent: "explain",
      prompt: "SELECT * FROM users",
    });
  });

  it("wraps a thrown AiError in AiUpstreamError with cause preserved", async () => {
    const { history } = makeHistory();
    const cause = new AiError("upstream went sideways");
    const explain = vi.fn().mockRejectedValue(cause);
    const useCase = new ExplainSql(makeProvider({ explain }), history);

    const err = await useCase.execute({ sql: "SELECT 1" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiUpstreamError);
    expect((err as AiUpstreamError).cause).toBe(cause);
  });

  it("lets non-AiError throws bubble untouched (programming bugs, not upstream failures)", async () => {
    const { history } = makeHistory();
    const bug = new TypeError("undefined.foo");
    const explain = vi.fn().mockRejectedValue(bug);
    const useCase = new ExplainSql(makeProvider({ explain }), history);

    await expect(useCase.execute({ sql: "SELECT 1" })).rejects.toBe(bug);
  });
});
