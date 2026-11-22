<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { ClusterAgents } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import AgentUpdateDialog from './AgentUpdateDialog.vue';

// A cluster's or fleet's settings: the agents' versions, always, and the update command, also
// when everything is current (re-running it repairs an install), ADR-227.
const props = defineProps<{ clusterId: string }>();
const data = ref<ClusterAgents | null>(null);
const open = ref(false);
onMounted(async () => {
  try {
    data.value = await api<ClusterAgents>(`/clusters/${props.clusterId}/agents`);
  } catch {
    data.value = null;
  }
});
const versions = computed(() => {
  const counts = new Map<string, number>();
  for (const a of data.value?.agents ?? []) counts.set(a.version, (counts.get(a.version) ?? 0) + 1);
  return [...counts].map(([v, n]) => `${v} (${n})`).join(', ');
});
</script>

<template>
  <section class="rounded-card border border-border bg-surface-1" data-testid="agents-section">
    <div
      class="flex items-center justify-between gap-4 px-5 py-4 max-md:flex-col max-md:items-stretch max-md:gap-3 max-md:px-4"
    >
      <div>
        <h3 class="text-14 font-semibold text-text">{{ $t('agents.settings.title') }}</h3>
        <p v-if="data && data.agents.length" class="mt-1 text-13 text-text-muted">
          <span data-testid="agents-versions">{{ $t('agents.settings.found', { versions }) }}</span>
          ·
          <span v-if="data.outOfDate" class="text-warning-text">{{
            data.kind === 'server'
              ? $t('agents.banner.servers', { n: data.outOfDate, total: data.agents.length })
              : $t('agents.banner.nodes', { n: data.outOfDate, total: data.agents.length })
          }}</span>
          <span v-else>{{ $t('agents.settings.current', { latest: data.latest }) }}</span>
        </p>
        <p v-else-if="data" class="mt-1 text-13 text-text-muted">
          {{ $t('agents.settings.none') }}
        </p>
      </div>
      <BaseButton v-if="data" variant="secondary" data-testid="agents-open" @click="open = true">
        {{ data.outOfDate ? $t('agents.settings.open') : $t('agents.settings.repair') }}
      </BaseButton>
    </div>
    <AgentUpdateDialog v-model:open="open" :cluster-id="clusterId" />
  </section>
</template>
