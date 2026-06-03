<script setup lang="ts">
// Served by the Workbox service worker as the navigateFallback when the
// network is unreachable. Kept fully self-contained — no runtime data
// fetching — so a cold offline launch can render it from precache alone.
useHead({
  title: "Offline — dbboard-web",
});
</script>

<template>
  <section class="offline">
    <h2>You are offline</h2>
    <p>
      dbboard-web needs a network connection to reach your databases. Your last cached UI shell is
      still loaded — reconnect to run queries again.
    </p>
    <p class="hint">If you came here on purpose, refresh the page once your connection is back.</p>
  </section>
</template>

<style scoped>
.offline {
  max-width: 32rem;
}

.offline h2 {
  margin-top: 0;
}

.offline .hint {
  color: var(--text-muted, #5a6573);
  font-size: 0.9rem;
}
</style>
