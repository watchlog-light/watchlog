<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { Doc } from '~/utils/docs';

// One rendered Markdown page (docs, security, legal), with the docs list beside it.
const props = defineProps<{ doc: Doc; kicker: string; nav?: boolean }>();
const docs = props.nav ? [...listDocs(), getDoc('security')!] : [];
</script>

<template>
  <div class="page">
    <div class="in">
      <div class="page-head">
        <span class="kicker">{{ kicker }}</span>
        <h1>{{ doc.title }}</h1>
        <p v-if="doc.description">{{ doc.description }}</p>
      </div>
      <div :class="{ 'docs-layout': nav }">
        <nav v-if="nav" class="docs-nav" aria-label="Documentation">
          <ul>
            <li v-for="d in docs" :key="d.slug">
              <a :href="d.path" :aria-current="d.slug === doc.slug ? 'page' : undefined">{{
                d.title
              }}</a>
            </li>
          </ul>
        </nav>
        <!-- Rendered at build time from the repository's own Markdown, raw HTML dropped (utils/docs.ts). -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <article class="prose" v-html="doc.html"></article>
      </div>
    </div>
  </div>
</template>
