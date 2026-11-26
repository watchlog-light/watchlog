<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Send from Prometheus (1.0.3): said first who it is for; a token made right here; the
// prometheus.yml block filled with this installation's address and the token, keeping only
// named metrics; and the moment the first samples arrive.
import type { OwnMetricsSummary } from '@watchlog/api-types';
import { remoteWriteSnippet } from '@watchlog/snippets';
import { computed } from 'vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import FirstValue from './FirstValue.vue';
import StepRow from './StepRow.vue';
import TokenStep, { type MadeToken } from './TokenStep.vue';

const props = defineProps<{
  cluster: string;
  summary: OwnMetricsSummary;
  made: MadeToken | null;
  watching: string | null;
}>();
const emit = defineEmits<{ made: [token: MadeToken]; watch: [id: string | null]; changed: [] }>();
const code = computed(() => remoteWriteSnippet(props.summary.endpoint, props.made?.value ?? ''));
</script>

<template>
  <div class="flex flex-col" data-testid="own-prometheus">
    <div class="pb-4">
      <h2 class="text-16 font-semibold text-text">{{ $t('ownMetrics.add.prometheus.h') }}</h2>
      <p class="mt-2 text-14 leading-relaxed text-text-muted" data-testid="own-prometheus-who">
        {{ $t('ownMetrics.add.prometheus.who') }}
      </p>
    </div>
    <StepRow :n="1" :title="$t('ownMetrics.add.token.h')">
      <p class="mb-3 text-13 leading-relaxed text-text-muted">
        {{ $t('ownMetrics.add.token.what') }}
      </p>
      <TokenStep
        :cluster="cluster"
        :summary="summary"
        :made="made"
        :watching="props.watching"
        @made="emit('made', $event)"
        @watch="emit('watch', $event)"
        @changed="emit('changed')"
      />
    </StepRow>
    <StepRow :n="2" :title="$t('ownMetrics.add.prometheus.code')">
      <div class="min-w-0" data-testid="own-prometheus-code">
        <CodeBlock :code="code" label="prometheus.yml" />
      </div>
      <p v-if="!made" class="mt-2 text-13 text-text-muted" data-testid="own-token-hint">
        {{ $t('ownMetrics.add.token.fill') }}
      </p>
      <p class="mt-2 text-13 leading-relaxed text-text-muted">
        {{ $t('ownMetrics.add.prometheus.keep') }} {{ $t('ownMetrics.add.prometheus.tied') }}
      </p>
    </StepRow>
    <FirstValue
      class="mt-1"
      :cluster="cluster"
      :summary="summary"
      :token-id="made?.id ?? props.watching"
      :fresh="!!made"
      way="prometheus"
      @changed="emit('changed')"
    />
  </div>
</template>
