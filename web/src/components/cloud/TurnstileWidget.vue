<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ref, toRef, watch } from 'vue';
import { useTurnstile } from '@/composables/useTurnstile';

// The human check (ADR-175): Cloudflare's widget, usually a tick with no puzzle. The token
// is the v-model; `reset()` asks for a new one after a submit.
const props = defineProps<{ siteKey: string }>();
const token = defineModel<string | null>({ required: true });
const el = ref<HTMLElement | null>(null);
const turnstile = useTurnstile(toRef(props, 'siteKey'), el);
watch(turnstile.token, (t) => (token.value = t));
defineExpose({ reset: turnstile.reset });
</script>

<template>
  <div class="flex flex-col gap-1.5" data-testid="turnstile">
    <div ref="el" class="min-h-16.5" role="group" :aria-label="$t('cloud.turnstile.label')" />
    <p v-if="turnstile.failed.value" role="alert" class="text-12 text-critical">
      {{ $t('cloud.turnstile.failed') }}
    </p>
  </div>
</template>
