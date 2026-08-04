<script setup lang="ts">
// The draggable divider between the editor and the sidebar (desktop ADR-0083).
//
// It is a real `role="separator"` with `tabindex`, arrow keys and `Home`
// (decision 5): a drag handle reachable only by mouse is not a control. The
// pointer plumbing uses pointer capture, because the pointer always outruns a
// target this narrow and without capture the drag dies when it does.
//
// The component is deliberately stateless about *size*. It reports where the
// user is asking the divider to go and the page's `useSidebarWidth` decides
// what is legal — the same split desktop draws between the divider markup and
// `$lib/layout/splitter`.

import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_NUDGE } from "../utils/splitter";

const props = defineProps<{ width: number }>();
const emit = defineEmits<{ resize: [width: number]; nudge: [delta: number]; reset: [] }>();

const { t } = useI18n();

const dragging = ref(false);
// Where the press landed, and how wide the sidebar was then. Every move is
// measured from these rather than from the previous move: accumulating deltas
// drifts, and the divider ends up lagging the pointer by however many events
// the browser coalesced.
let startX = 0;
let startWidth = 0;

function onPointerDown(event: PointerEvent) {
  // A right-click opens a context menu; a drag started under it would have no
  // pointerup to end it.
  if (event.button !== 0) return;
  dragging.value = true;
  startX = event.clientX;
  startWidth = props.width;
  capture(event, "set");
  event.preventDefault();
}

function onPointerMove(event: PointerEvent) {
  if (!dragging.value) return;
  // The sidebar is to the *right* of the divider on this page, so moving the
  // pointer left makes it wider. Desktop's sidebar is on the left and reads
  // the opposite way; the sign belongs here, with the layout that fixes it.
  emit("resize", startWidth + (startX - event.clientX));
}

function onPointerUp(event: PointerEvent) {
  if (!dragging.value) return;
  dragging.value = false;
  capture(event, "release");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    emit("nudge", event.key === "ArrowLeft" ? SIDEBAR_NUDGE : -SIDEBAR_NUDGE);
  } else if (event.key === "Home") {
    emit("reset");
  } else {
    // Tab has to keep moving focus, and every other key belongs to whatever
    // handles it next.
    return;
  }
  event.preventDefault();
}

/**
 * Pointer capture, where it exists.
 *
 * Some embedded WebViews ship pointer events without the capture methods, and
 * losing the capture is a degraded drag rather than a broken page — so this
 * checks rather than assumes.
 */
function capture(event: PointerEvent, action: "set" | "release") {
  const el = event.currentTarget as HTMLElement | null;
  const method = action === "set" ? el?.setPointerCapture : el?.releasePointerCapture;
  if (typeof method !== "function") return;
  method.call(el, event.pointerId);
}
</script>

<template>
  <div
    class="splitter"
    :class="{ 'splitter--dragging': dragging }"
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :aria-label="t('sidebar.resize')"
    :title="t('sidebar.resize')"
    :aria-valuenow="props.width"
    :aria-valuemin="SIDEBAR_MIN_WIDTH"
    :aria-valuemax="SIDEBAR_MAX_WIDTH"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @dblclick="emit('reset')"
    @keydown="onKeydown"
  />
</template>

<style scoped>
.splitter {
  /* Drawn as a hairline but grabbed as a 44px-wide target — the Phase 1.5 DoD
     minimum, and about four times what a 7px handle gives a trackpad. */
  flex: 0 0 auto;
  align-self: stretch;
  box-sizing: content-box;
  width: 1px;
  min-width: 1px;
  padding: 0 12px;
  background-clip: content-box;
  background-color: var(--border);
  cursor: col-resize;
  touch-action: none;
}

.splitter:hover,
.splitter--dragging {
  background-color: var(--accent);
}

.splitter:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
