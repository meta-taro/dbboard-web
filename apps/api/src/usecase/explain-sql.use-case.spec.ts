import { describe, expect, it, vi } from "vitest";
import { AiDisabledError, AiError, AiUpstreamError } from "../domain/ai/ai-error";
import { AiUnknownProviderError } from "../domain/ai/ai-provider-registry.port";
import {
  NO_AI_CAPABILITIES,
  type AiProvider,
  type AiResponse,
  type ExplainRequest,
} from "../domain/ai/ai-provider.port";
import { StaticAiProviderRegistry } from "../infrastructure/static-ai-provider-registry";
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

// The use case now takes a registry rather than a provider, so the
// single-provider case has to be spelled as a one-entry registry. Real
// registries come from the environment (ai-providers.config.ts); this is
// the shortest thing that satisfies the port.
function registryOf(...providers: AiProvider[]): StaticAiProviderRegistry {
  const entries = providers.map((provider, i) => ({
    id: `p${i}`,
    name: `p${i}`,
    kind: "anthropic" as const,
    model: provider.getModel(),
    provider,
  }));
  return new StaticAiProviderRegistry(entries, "p0");
}

function emptyRegistry(): StaticAiProviderRegistry {
  return new StaticAiProviderRegistry([], undefined);
}

function makeHistory(): {
  history: RecordHistory;
  recordAiSuccess: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
} {
  // `record` is exposed as well as the spy: the disabled and
  // unknown-provider paths must write *nothing at all*, and a spy on one
  // of the two recorder methods cannot say that.
  const record = vi.fn(() => Promise.resolve());
  const history = new RecordHistory({
    record,
    // eslint-disable-next-line require-yield
    iterate: async function* () {
      throw new Error("not used in these tests");
    },
  });
  const recordAiSuccess = vi.spyOn(history, "recordAiSuccess") as unknown as ReturnType<
    typeof vi.fn
  >;
  return { history, recordAiSuccess, record };
}

const RESPONSE: AiResponse = {
  text: "explanation",
  model: "claude-x",
  tokensIn: 10,
  tokensOut: 20,
  stopReason: "end_turn",
};

describe("ExplainSql", () => {
  it("throws AiDisabledError when no provider is configured, and writes nothing", async () => {
    const { history, record } = makeHistory();
    const useCase = new ExplainSql(emptyRegistry(), history);
    await expect(useCase.execute({ sql: "SELECT 1" })).rejects.toBeInstanceOf(AiDisabledError);
    // Slice B moved this refusal from runRecordedAiCall into the
    // registry; the guarantee it carried — no call, so no record —
    // is asserted here rather than lost with the branch.
    expect(record).not.toHaveBeenCalled();
  });

  it("delegates to provider.explain with the request verbatim", async () => {
    const { history } = makeHistory();
    const explain = vi.fn().mockResolvedValue(RESPONSE);
    const useCase = new ExplainSql(registryOf(makeProvider({ explain })), history);
    const request: ExplainRequest = { sql: "SELECT 1", dialect: "postgres" };

    const result = await useCase.execute(request);

    expect(explain).toHaveBeenCalledExactlyOnceWith(request);
    expect(result).toStrictEqual(RESPONSE);
  });

  it("records the explain intent with the SQL as the prompt", async () => {
    const { history, recordAiSuccess } = makeHistory();
    const explain = vi.fn().mockResolvedValue(RESPONSE);
    const useCase = new ExplainSql(registryOf(makeProvider({ explain })), history);

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
    const useCase = new ExplainSql(registryOf(makeProvider({ explain })), history);

    const err = await useCase.execute({ sql: "SELECT 1" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiUpstreamError);
    expect((err as AiUpstreamError).cause).toBe(cause);
  });

  it("lets non-AiError throws bubble untouched (programming bugs, not upstream failures)", async () => {
    const { history } = makeHistory();
    const bug = new TypeError("undefined.foo");
    const explain = vi.fn().mockRejectedValue(bug);
    const useCase = new ExplainSql(registryOf(makeProvider({ explain })), history);

    await expect(useCase.execute({ sql: "SELECT 1" })).rejects.toBe(bug);
  });

  describe("provider selection (0032 slice B)", () => {
    it("asks the named provider, not the default", async () => {
      const { history } = makeHistory();
      const first = vi.fn().mockResolvedValue(RESPONSE);
      const second = vi.fn().mockResolvedValue(RESPONSE);
      const useCase = new ExplainSql(
        registryOf(makeProvider({ explain: first }), makeProvider({ explain: second })),
        history,
      );

      await useCase.execute({ sql: "SELECT 1", provider: "p1" });

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });

    it("does not pass the provider id down to the provider — it is addressing, not content", async () => {
      const { history } = makeHistory();
      const explain = vi.fn().mockResolvedValue(RESPONSE);
      const useCase = new ExplainSql(registryOf(makeProvider({ explain })), history);

      await useCase.execute({ sql: "SELECT 1", provider: "p0" });

      expect(explain).toHaveBeenCalledExactlyOnceWith({ sql: "SELECT 1" });
    });

    it("rejects an unconfigured name without calling anyone or recording anything", async () => {
      const { history, recordAiSuccess } = makeHistory();
      const explain = vi.fn().mockResolvedValue(RESPONSE);
      const useCase = new ExplainSql(registryOf(makeProvider({ explain })), history);

      await expect(useCase.execute({ sql: "SELECT 1", provider: "nope" })).rejects.toBeInstanceOf(
        AiUnknownProviderError,
      );
      expect(explain).not.toHaveBeenCalled();
      // Nothing was asked, so nothing was spent, so there is nothing to
      // record — the same reasoning as the disabled case.
      expect(recordAiSuccess).not.toHaveBeenCalled();
    });
  });
});
