/**
 * Asks a bastion what host key it presents, on demand (0031 slice F3).
 *
 * Deliberately not an `onMounted` fetch like `useDrivers`. The driver list is
 * a fact about the API build and costs nothing to read; this dials a machine
 * the operator named, so ADR-0076 makes it an explicit button. Fetching while
 * the host box is still being typed in would connect to whatever prefix
 * happened to resolve.
 *
 * What it does *not* do is decide anything about the key. The fingerprint it
 * returns is what the server saw, and pinning it is the caller's act — the
 * point of showing it at all is that a human compares it against the value
 * they got out of band before it becomes the thing the tunnel trusts.
 */
import { readonly, ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { apiFetch } from "./internal/http";
import { parseError, type CategorisedError } from "./internal/i18n-error";

export interface UseSshHostKeyOptions {
  apiBase?: string;
}

export type SshHostKeyState = "idle" | "probing" | "error";

interface ProbeResponse {
  fingerprint: string;
}

function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

export function useSshHostKey(options?: UseSshHostKeyOptions) {
  const apiBase = resolveApiBase(options?.apiBase);
  const fingerprint = ref<string | null>(null);
  const lastError = ref<CategorisedError | null>(null);
  const state = ref<SshHostKeyState>("idle");

  function reset(): void {
    fingerprint.value = null;
    lastError.value = null;
    state.value = "idle";
  }

  async function probe(host: string, port?: number): Promise<string | null> {
    const trimmed = host.trim();
    // Refused here rather than at the door: the server would answer 422, but
    // the round trip would also blank the previous answer and dress a form
    // mistake up as a server error.
    if (trimmed === "") return null;

    // Cleared first, not on success. A fingerprint left on screen while a
    // different host is being probed is the one way this composable could get
    // someone to pin the wrong key.
    reset();
    state.value = "probing";

    // Port omitted rather than defaulted to 22. `ProbeSshHostKey` already
    // resolves it, and it is the same default the tunnel dials with — a
    // second copy here could drift, and then the key being compared would
    // belong to a different listener than the one the tunnel connects to.
    const body: { host: string; port?: number } = { host: trimmed };
    if (port !== undefined) body.port = port;

    try {
      const res = await apiFetch<ProbeResponse>(`${apiBase}/connections/ssh/host-key`, {
        method: "POST",
        body,
      });
      fingerprint.value = res.fingerprint;
      state.value = "idle";
      return res.fingerprint;
    } catch (err: unknown) {
      lastError.value = parseError(err);
      state.value = "error";
      return null;
    }
  }

  return {
    fingerprint: readonly(fingerprint),
    lastError: readonly(lastError),
    state: readonly(state),
    probe,
    reset,
  };
}
