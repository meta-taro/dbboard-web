import { AiDisabledError } from "../domain/ai/ai-error";
import {
  AiUnknownProviderError,
  type AiProviderDescriptor,
  type AiProviderRegistry,
} from "../domain/ai/ai-provider-registry.port";
import type { AiProvider } from "../domain/ai/ai-provider.port";

// One configured provider: the descriptor fields plus the live client
// that answers for them. The pairing exists only here — `list()` hands
// out descriptors and `resolve()` hands out clients, and nothing hands
// out both.
export interface AiProviderEntry {
  id: string;
  name: string;
  kind: string;
  model: string;
  provider: AiProvider;
}

// "Static" because the set is fixed when the process starts: it comes
// from the environment (bootstrap/ai-providers.config.ts), and web has
// no equivalent of desktop's editable ai-providers.toml. Nothing here
// mutates, which is also what makes it safe to share across the
// concurrent requests a server has and a desktop app does not.
export class StaticAiProviderRegistry implements AiProviderRegistry {
  private readonly byId: Map<string, AiProviderEntry>;

  constructor(
    private readonly entries: AiProviderEntry[],
    private readonly defaultId: string | undefined,
  ) {
    this.byId = new Map(entries.map((entry) => [entry.id, entry]));
    if (entries.length > 0 && defaultId === undefined) {
      throw new Error(
        "AI provider registry has entries but no default — every configured deployment must be able to answer a request that names nobody",
      );
    }
    if (defaultId !== undefined && !this.byId.has(defaultId)) {
      throw new Error(`AI provider registry default "${defaultId}" names no configured provider`);
    }
  }

  list(): AiProviderDescriptor[] {
    return this.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      model: entry.model,
      default: entry.id === this.defaultId,
      // Asked of the provider rather than stored on the entry: the
      // entry is configuration, and whether a client streams is a
      // property of the adapter, not of what the operator typed.
      streaming: entry.provider.getCapabilities().streaming,
    }));
  }

  resolve(id: string | undefined): AiProvider {
    // Emptiness is checked before the lookup so a deployment with no key
    // answers "AI is not configured" whatever id it was handed. The
    // message is the one Stage 1 used, because the panel and the tests
    // that hide it match on the 404 envelope.
    if (this.entries.length === 0) {
      throw new AiDisabledError("AI provider is not configured");
    }
    const entry = this.byId.get(id ?? (this.defaultId as string));
    if (entry === undefined) {
      const known = this.entries.map((e) => e.id).join(", ");
      throw new AiUnknownProviderError(
        `AI provider "${id ?? ""}" is not configured — this deployment has: ${known}`,
      );
    }
    return entry.provider;
  }
}
