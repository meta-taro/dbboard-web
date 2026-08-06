/**
 * The logical-restore (import) driver — ticket 0030, the web mirror of
 * desktop ADR-0051 and of `$lib/restore/plan.ts` there.
 *
 * Two requests, always in that order: a preflight that classifies the script
 * and reports what the target already holds, then the run. The plan is never
 * sent back to the server — it re-plans from the script, so a stale plan has
 * no way to reach execution (ADR-0065). What the plan is for here is the
 * question it lets the UI ask before the second request goes out.
 *
 * Three things differ from desktop, all of them because the wire is HTTP and
 * not an IPC channel to a process holding the file:
 *
 *   - the script travels in the body rather than as a path, so the browser
 *     reads the file and this posts its text;
 *   - there is no `restore:progress` event to subscribe to, so a run is
 *     indeterminate rather than a statement counter;
 *   - cancelling is aborting the request rather than a second command. The
 *     server notices the socket close and rolls back, but the client gets no
 *     body back, so a cancelled run reports no counts.
 */
import { computed, readonly, ref, type ComputedRef, type Ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { rawFetch } from "./internal/download";
import { parseError, type CategorisedError } from "./internal/i18n-error";

/** Mirrors the API's plan response, which mirrors desktop's `RestorePlanDto`. */
export interface RestorePlan {
  /** Runnable statements only — transaction control is stripped and excluded. */
  statements_total: number;
  ddl_count: number;
  data_count: number;
  /** Statements the classifier could not parse; they still run verbatim. */
  unparsed_count: number;
  existing_tables: string[];
  is_target_empty: boolean;
}

export interface StatementFailure {
  index: number;
  message: string;
}

export interface RestoreOutcome {
  statements_run: number;
  ddl_run: number;
  data_run: number;
  failures: StatementFailure[];
  cancelled: boolean;
  /** True if the script ran as one atomic batch (all-or-nothing). */
  atomic: boolean;
}

/** On-error policy for the per-statement (non-atomic) path. `stop` is safest. */
export type OnError = "stop" | "continue";

/**
 * `idle` waits for a file: unlike a dump, a restore has no source until the
 * user picks one, so there is nothing to preflight on mount. `cancelled` is
 * its own state rather than an outcome flag because an aborted request
 * carries no outcome to set the flag on.
 */
export type RestoreState =
  | "idle"
  | "planning"
  | "ready"
  | "running"
  | "done"
  | "cancelled"
  | "failed";

export interface UseRestoreOptions {
  apiBase?: string;
}

export interface UseRestoreApi {
  state: Readonly<Ref<RestoreState>>;
  plan: Readonly<Ref<RestorePlan | null>>;
  outcome: Readonly<Ref<RestoreOutcome | null>>;
  lastError: Readonly<Ref<CategorisedError | null>>;
  /** The chosen file's name, for display only. */
  filename: Readonly<Ref<string | null>>;
  /** The user's answer to the non-empty-target gate. Writable — it is a checkbox. */
  confirmed: Ref<boolean>;
  onError: Ref<OnError>;
  mustConfirm: ComputedRef<boolean>;
  canRun: ComputedRef<boolean>;
  preflight: (script: string, filename: string) => Promise<void>;
  run: () => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  // Mirrors useConnections — see note there.
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

// The route answers errors with the contract envelope, but a proxy or a crash
// can answer with anything. `parseError` degrades a shapeless failure into the
// `connection` category, so feed it whatever came back rather than guessing.
async function envelopeError(response: Response): Promise<CategorisedError> {
  try {
    return parseError({ data: await response.json() });
  } catch {
    return parseError(new Error(`HTTP ${response.status}`));
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export function useRestore(connectionId: string, options?: UseRestoreOptions): UseRestoreApi {
  const apiBase = resolveApiBase(options?.apiBase);
  const state = ref<RestoreState>("idle");
  const plan = ref<RestorePlan | null>(null);
  const outcome = ref<RestoreOutcome | null>(null);
  const lastError = ref<CategorisedError | null>(null);
  const filename = ref<string | null>(null);
  const confirmed = ref(false);
  const onError = ref<OnError>("stop");

  // Held so the run can re-post it. Not exposed: a caller that wanted to run
  // a *different* script than the one it planned would be doing exactly what
  // re-plan-on-run exists to prevent.
  let script: string | null = null;
  let inFlight: AbortController | null = null;

  const mustConfirm = computed(() => plan.value !== null && !plan.value.is_target_empty);
  const canRun = computed(() => plan.value !== null && (!mustConfirm.value || confirmed.value));

  function routeFor(path: string): string {
    return `${apiBase}/connections/${encodeURIComponent(connectionId)}/${path}`;
  }

  async function preflight(nextScript: string, nextFilename: string): Promise<void> {
    // A second file invalidates the first one's answers, consent included:
    // the user agreed to overwrite given *that* plan.
    script = nextScript;
    filename.value = nextFilename;
    plan.value = null;
    outcome.value = null;
    confirmed.value = false;
    lastError.value = null;
    state.value = "planning";

    try {
      const response = await rawFetch(routeFor("restore/plan"), {
        method: "POST",
        headers: { "Content-Type": "application/sql" },
        body: nextScript,
      });
      if (!response.ok) {
        lastError.value = await envelopeError(response);
        state.value = "failed";
        return;
      }
      plan.value = (await response.json()) as RestorePlan;
      state.value = "ready";
    } catch (err: unknown) {
      lastError.value = parseError(err);
      state.value = "failed";
    }
  }

  async function run(): Promise<void> {
    // Guarded rather than assumed: `canRun` is what the button is disabled
    // on, and a disabled button is a hint, not an enforcement.
    if (script === null || !canRun.value) return;

    outcome.value = null;
    lastError.value = null;
    state.value = "running";

    const controller = new AbortController();
    inFlight = controller;
    const query = `?confirmed=${confirmed.value ? "true" : "false"}&on_error=${onError.value}`;

    try {
      const response = await rawFetch(routeFor(`restore${query}`), {
        method: "POST",
        headers: { "Content-Type": "application/sql" },
        body: script,
        signal: controller.signal,
      });
      if (!response.ok) {
        lastError.value = await envelopeError(response);
        state.value = "failed";
        return;
      }
      // Per-statement failures are part of a completed run, not an error:
      // the server ran what it was asked to and is reporting what happened.
      outcome.value = (await response.json()) as RestoreOutcome;
      state.value = "done";
    } catch (err: unknown) {
      if (isAbort(err)) {
        // The user's own doing, so it is not banner material.
        state.value = "cancelled";
        return;
      }
      lastError.value = parseError(err);
      state.value = "failed";
    } finally {
      inFlight = null;
    }
  }

  /**
   * Web's answer to desktop's `cancel_restore`. Aborting the request closes
   * the socket, which is what the server watches for; on the atomic path that
   * only lands before the batch starts, which is the guarantee desktop gives
   * too.
   */
  function cancel(): void {
    inFlight?.abort();
  }

  function reset(): void {
    inFlight?.abort();
    script = null;
    filename.value = null;
    plan.value = null;
    outcome.value = null;
    lastError.value = null;
    confirmed.value = false;
    state.value = "idle";
  }

  return {
    state: readonly(state),
    plan: readonly(plan) as Readonly<Ref<RestorePlan | null>>,
    outcome: readonly(outcome) as Readonly<Ref<RestoreOutcome | null>>,
    lastError: readonly(lastError),
    filename: readonly(filename),
    confirmed,
    onError,
    mustConfirm,
    canRun,
    preflight,
    run,
    cancel,
    reset,
  };
}
