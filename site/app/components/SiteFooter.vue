<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import logoUrl from '@watchlog/design-tokens/assets/logo.svg';
import { repoLink, site } from '../../site.config';

const links = [
  ['/docs/', 'Docs'],
  ...(site.repoPublic
    ? [
        [repoLink(), 'GitHub'],
        [repoLink('/releases'), 'Changelog'],
      ]
    : []),
  ['/security/', 'Security'],
  ['/legal/privacy/', 'Privacy'],
  ['/legal/terms/', 'Terms'],
] as [string, string][];
</script>

<template>
  <footer class="footer">
    <div class="in">
      <a class="logo" href="/"><img :src="logoUrl" alt="" width="26" height="26" />WatchLog</a>
      <span class="sp"></span>
      <ul class="lk">
        <li v-for="[href, label] in links" :key="label">
          <a :href="href">{{ label }}</a>
        </li>
      </ul>
      <p class="fine">
        © 2026 {{ site.operator }} · Open source under AGPL-3.0 · No cookies, no analytics.
      </p>
    </div>
  </footer>
</template>
