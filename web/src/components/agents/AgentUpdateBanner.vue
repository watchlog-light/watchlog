<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { TriangleAlert } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { outOfDateLine } from '@/lib/agent-update';
import AgentUpdateDialog from './AgentUpdateDialog.vue';

// One banner over a fleet's Servers or a cluster's Nodes when any agent is older than this
// WatchLog (ADR-227), with "Update agents" opening the command for all of them.
const props = defineProps<{
  clusterId: string;
  kind: 'kubernetes' | 'server';
  old: number;
  total: number;
}>();
const { t } = useI18n();
const open = ref(false);
const line = computed(() =>
  outOfDateLine(props.kind, props.old, props.total, (k, v) => t(k, v ?? {})),
);
</script>

<template>
  <div
    v-if="old > 0"
    class="flex flex-wrap items-center gap-3 rounded-card border border-warning/40 bg-surface-1 px-4 py-3"
    role="status"
    data-testid="agent-banner"
  >
    <TriangleAlert class="size-4 shrink-0 text-warning-text" aria-hidden="true" />
    <span class="flex-1 text-13 text-text">{{ line }}</span>
    <button
      type="button"
      class="rounded-control border border-border px-3 py-1.5 text-13 font-medium text-text hover:bg-surface-2 max-lg:min-h-11"
      data-testid="agent-banner-update"
      @click="open = true"
    >
      {{ $t('agents.updateAgents') }}
    </button>
    <AgentUpdateDialog v-model:open="open" :cluster-id="clusterId" />
  </div>
</template>
