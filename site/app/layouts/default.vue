<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';

// The text font arrives with the first paint, so lines don't reflow when it swaps in.
useHead({
  link: [{ rel: 'preload', as: 'font', type: 'font/woff2', href: interLatin, crossorigin: '' }],
});
</script>

<template>
  <a class="skip" href="#main">Skip to content</a>
  <SiteNav />
  <main id="main">
    <slot />
  </main>
  <SiteFooter />
</template>
