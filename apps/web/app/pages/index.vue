<script setup lang="ts">
// Phase 1 scaffold placeholder. The real connection / query UI lands in
// later phases per .claude/roadmap.md (Phase 4 onward).
const apiBase = useRuntimeConfig().public.apiBaseUrl;
</script>

<template>
  <section>
    <h2>Phase 1 scaffold</h2>
    <p>
      API base URL: <code>{{ apiBase }}</code>
    </p>
  </section>
</template>
