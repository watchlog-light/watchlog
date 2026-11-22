<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { ClusterAgents } from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import { api } from '@/api/client';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { updateMethods, type UpdateMethod } from '@/lib/agent-update';

// Updating the agents (ADR-227), in the install dialog's look: the command filled in with this
// WatchLog's address and version, a copy button, method tabs only when the install method is
// unknown (the script's first), an SSH loop over the out-of-date servers of a fleet, and how
// the update behaves. `host` narrows it to one server (its page's chip).
const props = defineProps<{ clusterId: string; host?: string | null }>();
const open = defineModel<boolean>('open', { required: true });

const data = ref<ClusterAgents | null>(null);
const failed = ref(false);
watch(
  open,
  async (now) => {
    if (!now || data.value) return;
    failed.value = false;
    try {
      data.value = await api<ClusterAgents>(`/clusters/${props.clusterId}/agents`);
    } catch {
      failed.value = true;
    }
  },
  { immediate: true },
);

const methods = computed<UpdateMethod[]>(() =>
  data.value ? updateMethods(data.value, props.host ?? null) : [],
);
const picked = ref<UpdateMethod | null>(null);
const method = computed<UpdateMethod | null>(() =>
  picked.value && methods.value.includes(picked.value) ? picked.value : (methods.value[0] ?? null),
);
const command = computed(() => {
  const d = data.value;
  if (!d) return '';
  if (d.helm) return d.helm.command;
  return (method.value && d.server?.commands[method.value]) || '';
});
/** The loop over every out-of-date server: the whole fleet's dialog, with the loop's method. */
const loop = computed(() => {
  const s = data.value?.server;
  if (!s?.loop || props.host) return null;
  return (s.method ?? 'script') === method.value ? s.loop : null;
});
const versions = computed(() => {
  const d = data.value;
  if (!d) return '';
  const shown = props.host ? d.agents.filter((a) => a.host === props.host) : d.agents;
  return [...new Set(shown.map((a) => a.version))].sort().join(', ');
});
</script>

<template>
  <ModalDialog
    v-model:open="open"
    size="lg"
    :title="$t('agents.update.title')"
    :description="
      data
        ? $t(data.kind === 'server' ? 'agents.update.leadServers' : 'agents.update.leadNodes', {
            latest: data.latest,
            versions,
            n: host ? 1 : data.outOfDate,
          })
        : undefined
    "
  >
    <div class="flex flex-col gap-4" data-testid="agent-update">
      <p v-if="failed" class="text-13 text-critical-text" role="alert">
        {{ $t('agents.update.loadError') }}
      </p>
      <Skeleton v-else-if="!data" class="h-24 w-full" />
      <template v-else>
        <div
          v-if="methods.length > 1"
          class="flex flex-wrap gap-1"
          role="group"
          :aria-label="$t('onboarding.install.methods')"
          data-testid="agent-update-methods"
        >
          <button
            v-for="m in methods"
            :key="m"
            type="button"
            class="rounded-control px-2.5 py-1 text-12 max-lg:min-h-11"
            :class="method === m ? 'bg-surface-3 text-text' : 'text-text-muted hover:text-text'"
            :aria-pressed="method === m"
            :data-method="m"
            @click="picked = m"
          >
            {{ $t(`agents.update.method.${m}`) }}
          </button>
        </div>
        <CodeBlock
          :label="data.helm ? $t('agents.update.helmLabel') : $t(`agents.update.label.${method}`)"
          :code="command"
          data-testid="agent-update-command"
        />
        <p
          v-if="data.helm && !data.helm.known"
          class="text-13 text-text-muted"
          data-testid="agent-update-names"
        >
          {{ $t('agents.update.helmNames', { release: data.helm.chart }) }}
        </p>
        <p v-if="method === 'docker'" class="text-13 text-text-muted">
          {{ $t('agents.update.dockerNote') }}
        </p>
        <CodeBlock
          v-if="loop"
          :label="$t('agents.update.loopLabel', { n: data.outOfDate })"
          :code="loop"
          data-testid="agent-update-loop"
        />
        <p class="text-13 text-text-muted" data-testid="agent-update-keeps">
          {{ $t('agents.update.keeps') }} {{ $t('agents.update.after') }}
        </p>
      </template>
    </div>
  </ModalDialog>
</template>
