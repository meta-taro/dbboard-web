import type { Provider } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue 0019 — AI provider integration. The AppModule must boot in
// both modes (no AI key configured / key configured) so the Phase 6
// DoD bullet "core flows work with the AI module disabled" stays true.
// Both modes also need to keep the existing controllers wired so this
// slice cannot regress unrelated routes.
//
// Ticket 0032 slice B replaced the single AI_PROVIDER token with a
// registry, so the two modes are now "the registry is empty" and "the
// registry has entries" — and there is a third, several entries, which
// is what the slice added. What has not changed is that the disabled
// deployment boots.

async function compileAppWithEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const { AppModule } = await import("../src/app.module");
  const { AI_PROVIDER_REGISTRY } = await import("../src/domain/ai/ai-provider-registry.port");
  const { HealthController } = await import("../src/presentation/health.controller");
  const { ConnectionsController } = await import("../src/presentation/connections.controller");

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  return { moduleRef, AI_PROVIDER_REGISTRY, HealthController, ConnectionsController };
}

interface RegistryLike {
  list(): { id: string; kind: string; model: string; default: boolean }[];
  resolve(id: string | undefined): { getId(): string; getModel(): string };
}

describe("AppModule AI provider wiring (0019, 0032 slice B)", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  const NOTHING = {
    DBBOARD_ANTHROPIC_API_KEY: undefined,
    DBBOARD_ANTHROPIC_MODEL: undefined,
    DBBOARD_AI_PROVIDERS: undefined,
    DBBOARD_AI_DEFAULT: undefined,
  };

  it("boots with an empty registry when nothing is configured, and keeps core controllers wired", async () => {
    const { moduleRef, AI_PROVIDER_REGISTRY, HealthController, ConnectionsController } =
      await compileAppWithEnv(NOTHING);

    const registry = moduleRef.get<RegistryLike>(AI_PROVIDER_REGISTRY);
    expect(registry.list()).toStrictEqual([]);
    expect(moduleRef.get(HealthController)).toBeDefined();
    expect(moduleRef.get(ConnectionsController)).toBeDefined();
    await moduleRef.close();
  });

  it("turns the Stage 1 variables into a single 'anthropic' entry", async () => {
    const { moduleRef, AI_PROVIDER_REGISTRY, HealthController, ConnectionsController } =
      await compileAppWithEnv({
        ...NOTHING,
        DBBOARD_ANTHROPIC_API_KEY: "sk-ant-integration-fixture",
      });

    const registry = moduleRef.get<RegistryLike>(AI_PROVIDER_REGISTRY);
    expect(registry.list()).toStrictEqual([
      {
        id: "anthropic",
        name: "anthropic",
        kind: "anthropic",
        model: "claude-sonnet-4-6",
        default: true,
      },
    ]);
    // The resolved object is a real AnthropicProvider — the factory has
    // to construct clients, not just descriptors.
    expect(registry.resolve(undefined).getId()).toBe("anthropic");
    expect(moduleRef.get(HealthController)).toBeDefined();
    expect(moduleRef.get(ConnectionsController)).toBeDefined();
    await moduleRef.close();
  });

  it("builds one entry per listed id, with DBBOARD_AI_DEFAULT deciding which answers unnamed", async () => {
    const { moduleRef, AI_PROVIDER_REGISTRY } = await compileAppWithEnv({
      ...NOTHING,
      DBBOARD_AI_PROVIDERS: "fast,deep",
      DBBOARD_AI_FAST_KIND: "anthropic",
      DBBOARD_AI_FAST_API_KEY: "sk-ant-fast",
      DBBOARD_AI_DEEP_KIND: "anthropic",
      DBBOARD_AI_DEEP_MODEL: "claude-opus-4-8",
      DBBOARD_AI_DEEP_API_KEY: "sk-ant-deep",
      DBBOARD_AI_DEFAULT: "deep",
    });

    const registry = moduleRef.get<RegistryLike>(AI_PROVIDER_REGISTRY);
    expect(registry.list().map((d) => [d.id, d.default])).toStrictEqual([
      ["fast", false],
      ["deep", true],
    ]);
    // Two Anthropic entries are the same kind; the model is what tells
    // them apart, here and in the history record.
    expect(registry.resolve(undefined).getModel()).toBe("claude-opus-4-8");
    expect(registry.resolve("fast").getModel()).toBe("claude-sonnet-4-6");
    await moduleRef.close();
  });

  it("refuses to boot on a misconfigured list rather than silently dropping a provider", async () => {
    await expect(
      compileAppWithEnv({
        ...NOTHING,
        DBBOARD_AI_PROVIDERS: "deep",
        DBBOARD_AI_DEEP_KIND: "anthropic",
        DBBOARD_AI_DEEP_API_KEY: undefined,
      }),
    ).rejects.toThrow(/DBBOARD_AI_DEEP_API_KEY/);
  });

  it("registers AI_PROVIDER_REGISTRY as a real provider entry (sanity check that the factory is wired in)", async () => {
    const { AppModule } = await import("../src/app.module");
    const { AI_PROVIDER_REGISTRY } = await import("../src/domain/ai/ai-provider-registry.port");
    const metadata = Reflect.getMetadata("providers", AppModule) as Provider[] | undefined;
    expect(metadata).toBeDefined();
    const aiEntry = metadata?.find(
      (p) =>
        typeof p === "object" && p !== null && "provide" in p && p.provide === AI_PROVIDER_REGISTRY,
    );
    expect(aiEntry).toBeDefined();
  });
});
