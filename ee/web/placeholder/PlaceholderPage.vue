<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/api/client';

// The placeholder page (ADR-232): shows what the placeholder route answers.
const answer = ref<{ module: string; feature: string; licensed: boolean } | null>(null);
const failed = ref(false);
onMounted(async () => {
  try {
    answer.value = await api('/ee/placeholder');
  } catch {
    failed.value = true;
  }
});
</script>

<template>
  <section class="p-6" data-testid="ee-placeholder">
    <h1 class="text-20 font-semibold text-text">{{ $t('ee.placeholder.title') }}</h1>
    <p v-if="answer" class="mt-2 text-14 text-text-muted" data-testid="ee-placeholder-answer">
      {{ $t('ee.placeholder.answer', { module: answer.module, feature: answer.feature }) }}
    </p>
    <p v-else-if="failed" class="mt-2 text-14 text-text-muted">{{ $t('ee.placeholder.failed') }}</p>
  </section>
</template>
