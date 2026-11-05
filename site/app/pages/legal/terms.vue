<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
const doc = getLegal('terms');
usePage({ title: doc.title, description: doc.description, path: doc.path });
</script>

<template>
  <DocArticle :doc="doc" kicker="Legal" />
</template>
