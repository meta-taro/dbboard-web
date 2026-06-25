import type { Provider } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue 0019 — AI provider integration. The AppModule must boot in
// both modes (no AI key configured / key configured) so the Phase 6
// DoD bullet "core flows work with the AI module disabled" stays true.
// Both modes also need to keep the existing controllers wired so this
// slice cannot regress unrelated routes.

async function compileAppWithEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const { AppModule } = await import("../src/app.module");
  const { AI_PROVIDER } = await import("../src/domain/ai/ai-provider.port");
  const { HealthController } = await import("../src/presentation/health.controller");
  const { ConnectionsController } = await import("../src/presentation/connections.controller");

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  return { moduleRef, AI_PROVIDER, HealthController, ConnectionsController };
}

describe("AppModule AI provider wiring (0019)", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("resolves AI_PROVIDER to undefined when DBBOARD_ANTHROPIC_API_KEY is unset and keeps core controllers wired", async () => {
    const { moduleRef, AI_PROVIDER, HealthController, ConnectionsController } =
      await compileAppWithEnv({
        DBBOARD_ANTHROPIC_API_KEY: undefined,
        DBBOARD_ANTHROPIC_MODEL: undefined,
      });

    expect(moduleRef.get(AI_PROVIDER, { strict: false })).toBeUndefined();
    expect(moduleRef.get(HealthController)).toBeDefined();
    expect(moduleRef.get(ConnectionsController)).toBeDefined();
    await moduleRef.close();
  });

  it("resolves AI_PROVIDER to an AnthropicProvider when DBBOARD_ANTHROPIC_API_KEY is configured", async () => {
    const { moduleRef, AI_PROVIDER, HealthController, ConnectionsController } =
      await compileAppWithEnv({
        DBBOARD_ANTHROPIC_API_KEY: "sk-ant-integration-fixture",
        DBBOARD_ANTHROPIC_MODEL: undefined,
      });

    const provider = moduleRef.get<{ getId(): string }>(AI_PROVIDER);
    expect(provider).toBeDefined();
    expect(provider.getId()).toBe("anthropic");
    expect(moduleRef.get(HealthController)).toBeDefined();
    expect(moduleRef.get(ConnectionsController)).toBeDefined();
    await moduleRef.close();
  });

  it("registers AI_PROVIDER as a real provider entry (sanity check that the factory is wired in)", async () => {
    const { AppModule } = await import("../src/app.module");
    const { AI_PROVIDER } = await import("../src/domain/ai/ai-provider.port");
    const metadata = Reflect.getMetadata("providers", AppModule) as Provider[] | undefined;
    expect(metadata).toBeDefined();
    const aiEntry = metadata?.find(
      (p) => typeof p === "object" && p !== null && "provide" in p && p.provide === AI_PROVIDER,
    );
    expect(aiEntry).toBeDefined();
  });
});
