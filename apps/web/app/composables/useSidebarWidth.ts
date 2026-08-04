/**
 * The resizable sidebar's state. Mirrors desktop ADR-0083.
 *
 * The sizing rules live in `~/utils/splitter` and are testable without a DOM.
 * This composable owns only what can fail on the web: `localStorage`, the
 * window's width, and the resize listener.
 *
 * The width the user chose and the width actually applied are two different
 * numbers, and keeping them apart is ADR-0083 decision 3. `chosen` is never
 * clamped against the viewport; `width` is derived from it and the window as
 * it is now. Narrowing the window squeezes the sidebar, and widening it again
 * restores what the user asked for — clamping on write would have destroyed
 * that preference silently, at the moment it was least noticeable.
 *
 * Vue lifecycle helpers are imported explicitly rather than auto-imported so
 * the composable mounts in a plain happy-dom Vitest environment, as
 * `useTheme` does.
 */
import { computed, onBeforeUnmount, onMounted, readonly, ref } from "vue";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  parseSidebarWidth,
} from "../utils/splitter";

function readStoredWidth(): number {
  try {
    return parseSidebarWidth(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  } catch {
    // Private mode, a disabled-storage policy, or no window at all.
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function writeStoredWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Best-effort: the divider just will not stay put across reloads.
  }
}

function forgetStoredWidth(): void {
  try {
    window.localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
  } catch {
    // As above.
  }
}

export function useSidebarWidth() {
  // Both start at values that make the server-rendered markup and the first
  // client render agree; the real ones are read in onMounted.
  const chosen = ref(SIDEBAR_DEFAULT_WIDTH);
  const viewportWidth = ref(Number.POSITIVE_INFINITY);

  const width = computed(() => clampSidebarWidth(chosen.value, viewportWidth.value));

  /** Move the divider and remember where to. */
  function setWidth(next: number): void {
    chosen.value = clampSidebarWidth(next, viewportWidth.value);
    writeStoredWidth(chosen.value);
  }

  /**
   * Move the divider by one keyboard step.
   *
   * Stepping from `width` rather than `chosen` matters on a squeezed sidebar:
   * the divider has to move away from where it is *drawn*, or the first press
   * appears to do nothing while the remembered width catches up.
   */
  function nudge(delta: number): void {
    setWidth(width.value + delta);
  }

  /**
   * Back to the default, and forget the stored width (ADR-0083 decision 2).
   * Resetting the position but leaving the preference behind would be a lie
   * the next reload exposes.
   */
  function reset(): void {
    chosen.value = SIDEBAR_DEFAULT_WIDTH;
    forgetStoredWidth();
  }

  function onResize(): void {
    viewportWidth.value = window.innerWidth;
  }

  onMounted(() => {
    chosen.value = readStoredWidth();
    if (typeof window === "undefined") return;
    viewportWidth.value = window.innerWidth;
    window.addEventListener("resize", onResize);
  });

  onBeforeUnmount(() => {
    if (typeof window === "undefined") return;
    window.removeEventListener("resize", onResize);
  });

  return {
    width: readonly(width),
    setWidth,
    nudge,
    reset,
  };
}
