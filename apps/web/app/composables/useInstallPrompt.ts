/**
 * Captures the browser's `beforeinstallprompt` event so the UI can offer an
 * opt-in "Install" affordance instead of letting the browser show its own
 * banner. Surfaces nothing automatically — callers must invoke `prompt()`.
 *
 * Why opt-in: AI_AGENT_RULES.md + Phase 1.5 DoD require the install prompt to
 * never auto-push. The browser only fires `beforeinstallprompt` once per
 * navigation, so we stash the event and replay it on user action.
 *
 * Safari does not fire `beforeinstallprompt` — `canInstall` stays `false`
 * there. iOS install is documented through the manual share-sheet flow
 * elsewhere; this composable does not try to fake a prompt on Safari.
 *
 * Vue lifecycle helpers are imported explicitly (not via Nuxt auto-imports)
 * so the composable is mountable in a plain happy-dom Vitest environment.
 */
import { computed, onBeforeUnmount, onMounted, readonly, ref } from "vue";
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

export function useInstallPrompt() {
  const deferred = ref<BeforeInstallPromptEvent | null>(null);
  const installed = ref(false);
  const lastOutcome = ref<InstallOutcome | null>(null);

  const canInstall = computed(() => !installed.value && deferred.value !== null);

  function onBeforeInstallPrompt(event: Event) {
    // Prevent Chrome's mini-infobar so the UI controls the timing.
    event.preventDefault();
    deferred.value = event as BeforeInstallPromptEvent;
  }

  function onAppInstalled() {
    installed.value = true;
    deferred.value = null;
  }

  onMounted(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
  });

  onBeforeUnmount(() => {
    if (typeof window === "undefined") return;
    window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.removeEventListener("appinstalled", onAppInstalled);
  });

  async function prompt(): Promise<InstallOutcome> {
    const event = deferred.value;
    if (!event) {
      lastOutcome.value = "unavailable";
      return "unavailable";
    }
    await event.prompt();
    const { outcome } = await event.userChoice;
    // Spec: the event can only be used once.
    deferred.value = null;
    lastOutcome.value = outcome;
    return outcome;
  }

  return {
    canInstall,
    installed: readonly(installed),
    lastOutcome: readonly(lastOutcome),
    prompt,
  };
}
