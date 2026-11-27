<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import type { PanelOf } from '@/lib/panels';
import { whenAndAgo } from '@/lib/format';
import PanelLink from './PanelLink.vue';

// The probable cause in words (1.1.0, a queue's page), what it links to, and what WatchLog
// can't know: RabbitMQ doesn't say which client consumes which queue.
const props = defineProps<{ panel: PanelOf<'cause'> }>();
const text = computed(() => {
  const t = props.panel.text;
  if (!t) return null;
  const v = { ...(t.values ?? {}) };
  if (typeof v.at === 'number') v.at = whenAndAgo(v.at);
  return { key: t.key, values: v };
});
</script>

<template>
  <div class="flex flex-col gap-3 text-13">
    <p v-if="text" class="text-14 leading-relaxed text-text" data-testid="cause-text">
      {{ $t(text.key, text.values) }}
    </p>
    <p v-else class="text-text-muted" data-testid="cause-none">
      {{ $t('integrations.rabbitmq.panels.causeNone') }}
    </p>
    <p class="text-12 text-text-subtle">{{ $t(panel.caveat.key, panel.caveat.values ?? {}) }}</p>
    <div v-if="panel.links.length" class="flex flex-wrap gap-3">
      <PanelLink v-for="(l, i) in panel.links" :key="i" :link="l">{{
        $t('integrations.rabbitmq.panels.openName', { name: l.name })
      }}</PanelLink>
    </div>
  </div>
</template>
