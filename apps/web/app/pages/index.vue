<script setup lang="ts">
const apiBase = useRuntimeConfig().public.apiBaseUrl;
const { t } = useI18n();
</script>

<template>
  <section>
    <h2>{{ t("scaffold.heading") }}</h2>
    <p>
      {{ t("scaffold.api-base-label") }}: <code>{{ apiBase }}</code>
    </p>
    <p>
      <NuxtLink to="/connections">{{ t("connections.link-from-home") }}</NuxtLink>
    </p>
  </section>
</template>
