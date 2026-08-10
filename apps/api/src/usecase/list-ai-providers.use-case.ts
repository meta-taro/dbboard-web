import { AiDisabledError } from "../domain/ai/ai-error";
import type {
  AiProviderDescriptor,
  AiProviderRegistry,
} from "../domain/ai/ai-provider-registry.port";

// Backs `GET /ai/providers` (0032 slice B). Thin, but not empty: the
// decision it makes is that an empty list is not a list.
//
// A deployment with no provider answers 404 here, the same as the two
// call routes do, because CLAUDE.md rule 4 wants a provider-less
// deployment to look switched off rather than switched on and empty.
// A `200 { providers: [] }` would make the panel decide for itself what
// an empty array means, and it would have to agree with the server's
// answer on /ai/explain to stay coherent.
export class ListAiProviders {
  constructor(private readonly registry: AiProviderRegistry) {}

  execute(): AiProviderDescriptor[] {
    const providers = this.registry.list();
    if (providers.length === 0) {
      throw new AiDisabledError("AI provider is not configured");
    }
    return providers;
  }
}
