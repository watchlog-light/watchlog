<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import logoUrl from '@watchlog/design-tokens/assets/logo.svg';

// Section links point at the landing page from every page.
const links = [
  ['/#features', 'Features'],
  ['/#how', 'How it works'],
  ['/security/', 'Security'],
  ['/#cloud', 'Cloud'],
  ['/#faq', 'FAQ'],
  ['/docs/', 'Docs'],
] as const;
</script>

<template>
  <nav class="nav" aria-label="Main">
    <div class="in">
      <a class="logo" href="/"><img :src="logoUrl" alt="" width="26" height="26" />WatchLog</a>
      <div class="links">
        <a v-for="[href, label] in links" :key="href" :href="href">{{ label }}</a>
      </div>
      <span class="sp"></span>
      <RepoButton variant="nav" />
      <a class="btn primary small" href="/#install">Get started</a>
    </div>
  </nav>
</template>
