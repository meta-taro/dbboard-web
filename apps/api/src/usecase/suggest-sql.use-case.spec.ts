import { describe, expect, it, vi } from "vitest";
import { AiDisabledError, AiError, AiUpstreamError } from "../domain/ai/ai-error";
import {
  NO_AI_CAPABILITIES,
  type AiProvider,
  type AiResponse,
  type SuggestRequest,
} from "../domain/ai/ai-provider.port";
import { RecordHistory } from "./record-history.use-case";
import { SuggestSql } from "./suggest-sql.use-case";

// See explain-sql.use-case.spec.ts: the shared recording behaviour is
// covered in record-ai-call.spec.ts, so what is tested here is the
// delegation seam specific to SuggestSql.

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
  text: "SELECT * FROM users;",
  model: "claude-x",
  tokensIn: 10,
  tokensOut: 20,
  stopReason: "end_turn",
};

describe("SuggestSql", () => {
  it("throws AiDisabledError when no provider is configured", async () => {
    const { history } = makeHistory();
    const useCase = new SuggestSql(undefined, history);
    await expect(useCase.execute({ prompt: "users by signup date" })).rejects.toBeInstanceOf(
      AiDisabledError,
    );
  });

  it("delegates to provider.suggestSql with the request verbatim", async () => {
    const { history } = makeHistory();
    const suggestSql = vi.fn().mockResolvedValue(RESPONSE);
    const useCase = new SuggestSql(makeProvider({ suggestSql }), history);
    const request: SuggestRequest = { prompt: "all users", dialect: "postgres" };

    const result = await useCase.execute(request);

    expect(suggestSql).toHaveBeenCalledExactlyOnceWith(request);
    expect(result).toStrictEqual(RESPONSE);
  });

  it("records the suggest_sql intent with the natural-language prompt", async () => {
    const { history, recordAiSuccess } = makeHistory();
    const suggestSql = vi.fn().mockResolvedValue(RESPONSE);
    const useCase = new SuggestSql(makeProvider({ suggestSql }), history);

    await useCase.execute({ prompt: "all users" });

    expect(recordAiSuccess).toHaveBeenCalledOnce();
    expect(recordAiSuccess.mock.calls[0][0]).toMatchObject({
      intent: "suggest_sql",
      prompt: "all users",
    });
  });

  it("wraps a thrown AiError in AiUpstreamError with cause preserved", async () => {
    const { history } = makeHistory();
    const cause = new AiError("upstream went sideways");
    const suggestSql = vi.fn().mockRejectedValue(cause);
    const useCase = new SuggestSql(makeProvider({ suggestSql }), history);

    const err = await useCase.execute({ prompt: "x" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiUpstreamError);
    expect((err as AiUpstreamError).cause).toBe(cause);
  });

  it("lets non-AiError throws bubble untouched (programming bugs, not upstream failures)", async () => {
    const { history } = makeHistory();
    const bug = new TypeError("undefined.foo");
    const suggestSql = vi.fn().mockRejectedValue(bug);
    const useCase = new SuggestSql(makeProvider({ suggestSql }), history);

    await expect(useCase.execute({ prompt: "x" })).rejects.toBe(bug);
  });
});
