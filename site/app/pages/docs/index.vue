<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { site } from '../../../site.config';

usePage({
  title: 'Docs',
  description: 'Install, configure and run WatchLog on Kubernetes and Docker hosts.',
  path: '/docs/',
});
const docs = [...listDocs(), getDoc('security')!];
</script>

<template>
  <div class="page">
    <div class="in">
      <div class="page-head">
        <span class="kicker">Docs</span>
        <h1>Documentation</h1>
        <p>Install, configure and run WatchLog on Kubernetes and Docker hosts.</p>
        <p v-if="!site.repoPublic" class="notice" role="note">
          <strong>Open-source release coming soon.</strong> Install commands appear in these pages
          when version {{ site.version }} is released.
        </p>
      </div>
      <ul class="doc-list">
        <li v-for="d in docs" :key="d.slug">
          <a :href="d.path">
            <h2>{{ d.title }}</h2>
            <p>{{ d.description }}</p>
          </a>
        </li>
      </ul>
    </div>
  </div>
</template>
