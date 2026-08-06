/**
 * The download half of the whole-connection logical dump (ticket 0029, the
 * web mirror of desktop ADR-0049). The SQL itself is assembled server-side
 * and streamed; this only drives the request and hands the body to the
 * browser.
 *
 * Two-step by construction. Desktop asks about a large database in a modal
 * and proceeds on OK; over HTTP the same warn-and-allow becomes a refusal
 * the client answers, so the first request may come back 400 naming the row
 * count and the user re-sends it confirmed. That refusal is a *question* —
 * it stays out of the error banner.
 */
import { readonly, ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { rawFetch, saveBlob } from "./internal/download";
import { parseError, type CategorisedError } from "./internal/i18n-error";

export type DumpState = "idle" | "running" | "confirm" | "failed";

export interface UseDumpOptions {
  apiBase?: string;
}

function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  // Mirrors useConnections — see note there.
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

// Only used when the response carries no Content-Disposition, which a
// direct-to-API deployment can produce (a cross-origin fetch cannot read the
// header unless the server exposes it). Same stem the route uses so the two
// spellings do not drift.
function fallbackFilename(connectionId: string): string {
  const safe = connectionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return `dbboard-dump-${safe.length > 0 ? safe : "connection"}.sql`;
}

function filenameFrom(response: Response): string | null {
  const header = response.headers.get("Content-Disposition");
  return /filename="([^"]+)"/.exec(header ?? "")?.[1] ?? null;
}

// The route answers errors with the contract envelope, but a proxy or a
// crash can answer with anything at all. `parseError` already degrades a
// shapeless failure into the `connection` category, so feed it whatever
// came back rather than guessing.
async function envelopeError(response: Response): Promise<CategorisedError> {
  try {
    return parseError({ data: await response.json() });
  } catch {
    return parseError(new Error(`HTTP ${response.status}`));
  }
}

export function useDump(connectionId: string, options?: UseDumpOptions) {
  const apiBase = resolveApiBase(options?.apiBase);
  const state = ref<DumpState>("idle");
  const lastError = ref<CategorisedError | null>(null);
  /** The server's size refusal, verbatim — it names the row count. */
  const pendingConfirm = ref<string | null>(null);

  async function start(confirm = false): Promise<void> {
    state.value = "running";
    lastError.value = null;

    const url = `${apiBase}/connections/${encodeURIComponent(connectionId)}/dump${
      confirm ? "?confirm=true" : ""
    }`;

    try {
      const response = await rawFetch(url);

      if (!response.ok) {
        const error = await envelopeError(response);
        // 400 is the size gate — `prepare` has no other way to reach it.
        // Only on an unconfirmed request: asking again after the user
        // already said yes would loop the prompt forever.
        if (response.status === 400 && !confirm) {
          pendingConfirm.value = error.message;
          state.value = "confirm";
          return;
        }
        pendingConfirm.value = null;
        lastError.value = error;
        state.value = "failed";
        return;
      }

      // The response streams from the database, but the browser still has
      // to hold it before it can be written to disk. Nothing to be done
      // about that short of the File System Access API, which is not
      // everywhere — and the server side, which is the one that would
      // otherwise hold a whole database in RAM, stays streaming.
      saveBlob(await response.blob(), filenameFrom(response) ?? fallbackFilename(connectionId));
      pendingConfirm.value = null;
      state.value = "idle";
    } catch (err: unknown) {
      pendingConfirm.value = null;
      lastError.value = parseError(err);
      state.value = "failed";
    }
  }

  /** Answer the size question with "no". */
  function dismiss(): void {
    pendingConfirm.value = null;
    state.value = "idle";
  }

  return {
    state: readonly(state),
    lastError: readonly(lastError),
    pendingConfirm: readonly(pendingConfirm),
    start,
    dismiss,
  };
}
