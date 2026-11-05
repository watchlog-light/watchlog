<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { KeyRound } from '@lucide/vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import { computed } from 'vue';

// One install command per cluster kind: docker run per host, or helm install once.
const props = defineProps<{
  token: string;
  install: { dockerRun?: string; helm?: string };
  rotation?: boolean;
}>();
const kind = computed(() => (props.install.helm ? 'kubernetes' : 'docker'));
const command = computed(() => props.install.helm ?? props.install.dockerRun ?? '');
defineEmits<{ done: [] }>();
</script>

<template>
  <section
    data-testid="token-reveal"
    class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-5"
  >
    <div class="flex items-start gap-3">
      <KeyRound class="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
      <div>
        <h3 class="text-14 font-semibold text-text">{{ $t('clusters.reveal.title') }}</h3>
        <p class="mt-1 text-13 text-text-muted">{{ $t('clusters.reveal.once') }}</p>
      </div>
    </div>
    <CodeBlock :label="$t(`clusters.reveal.installLabel.${kind}`)" :code="command" />
    <p class="text-13 text-text-muted">
      {{
        rotation ? $t('clusters.reveal.rotationHint') : $t(`clusters.reveal.installHint.${kind}`)
      }}
    </p>
    <CodeBlock :label="$t('clusters.reveal.tokenLabel')" :code="token" />
    <div>
      <BaseButton variant="secondary" @click="$emit('done')">{{
        $t('clusters.reveal.done')
      }}</BaseButton>
    </div>
  </section>
</template>
