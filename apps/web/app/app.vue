<script setup lang="ts">
// Phase 1 scaffold placeholder. The real connection / query UI lands in
// later phases per .claude/roadmap.md (Phase 4 onward).
const apiBase = useRuntimeConfig().public.apiBaseUrl;
</script>

<template>
  <div class="app-shell">
    <header>
      <h1>dbboard-web</h1>
      <p>Browser-based multi-database client.</p>
    </header>
    <main>
      <p>
        Phase 1 scaffold. API base URL: <code>{{ apiBase }}</code>
      </p>
    </main>
  </div>
</template>

<style>
:root {
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    sans-serif;
  color-scheme: light dark;
}

body {
  margin: 0;
}

.app-shell {
  max-width: 60rem;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}

code {
  background: rgba(127, 127, 127, 0.15);
  padding: 0.1rem 0.35rem;
  border-radius: 0.25rem;
}
</style>
