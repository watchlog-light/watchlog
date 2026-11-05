<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { DOC_ORDER } from '~/utils/docs';

const slug = String(useRoute().params.slug);
const doc = (DOC_ORDER as readonly string[]).includes(slug) ? getDoc(slug) : null;
if (!doc) throw createError({ statusCode: 404, statusMessage: 'Page not found' });
usePage({ title: doc.title, description: doc.description, path: doc.path });
</script>

<template>
  <DocArticle v-if="doc" :doc="doc" kicker="Docs" nav />
</template>
