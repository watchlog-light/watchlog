<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
const doc = getDoc('security')!;
usePage({ title: doc.title, description: doc.description, path: '/security/' });
</script>

<template>
  <DocArticle :doc="doc" kicker="Security" nav />
</template>
