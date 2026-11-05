<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Prerendered and copied to 404.html (scripts/postgenerate.mjs); nginx serves it for
// any missing path.
usePage({ title: 'Page not found', description: 'This page does not exist.', path: '/not-found/' });
useHead({ meta: [{ name: 'robots', content: 'noindex' }] });
</script>

<template>
  <div class="not-found">
    <div class="in">
      <span class="kicker">404</span>
      <h1>This page doesn't exist.</h1>
      <p>It may have moved when the site was rebuilt.</p>
      <div class="ctas">
        <a class="btn primary" href="/">Go to the home page</a>
        <a class="btn ghost" href="/docs/">Read the docs</a>
      </div>
    </div>
  </div>
</template>
