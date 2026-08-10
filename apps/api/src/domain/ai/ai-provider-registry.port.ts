import { CategorizedError, type ErrorCategory } from "../errors/categorized-error";
import type { AiProvider } from "./ai-provider.port";

// Ticket 0032 slice B. Desktop lets the user keep several providers and
// pick one (ADR-0025); web keeps the same outcome without the settings
// UI, because the list comes from the environment rather than from a
// file the user can edit. What crosses into the domain is only the part
// that is not about storage: there is more than one provider, one of
// them answers when nobody says otherwise, and naming one that does not
// exist is an error rather than a quiet substitution.

// Raised when a request names a provider the deployment does not have.
// Deliberately *not* AiDisabledError: a 404 tells the client AI is off
// and the panel hides, which would be the wrong answer for a selector
// that has merely drifted out of step with the server.
export class AiUnknownProviderError extends CategorizedError {
  readonly category: ErrorCategory = "ai_unknown_provider";
}

// What `GET /ai/providers` returns per entry. This is a wire body, so it
// carries no provider instance and no key — see the registry's `list()`.
export interface AiProviderDescriptor {
  id: string;
  name: string;
  kind: string;
  model: string;
  default: boolean;
}

export interface AiProviderRegistry {
  list(): AiProviderDescriptor[];

  // `undefined` means the caller did not name one, and gets the default.
  // Throws AiDisabledError when nothing is configured at all, and
  // AiUnknownProviderError when the name is not among the configured
  // ones. The two are distinguished before the lookup: an empty
  // deployment answers "AI is off" whatever id it was handed.
  resolve(id: string | undefined): AiProvider;
}

export const AI_PROVIDER_REGISTRY = Symbol("AI_PROVIDER_REGISTRY");
