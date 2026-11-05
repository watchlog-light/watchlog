<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { highlightSegments } from '@/lib/filter';

const props = defineProps<{ text: string; terms: string[] }>();
const segments = computed(() => highlightSegments(props.text, props.terms));
</script>

<template>
  <template v-for="(s, i) in segments" :key="i">
    <mark v-if="s.match" class="rounded-sm bg-primary-soft text-text">{{ s.text }}</mark>
    <template v-else>{{ s.text }}</template>
  </template>
</template>
