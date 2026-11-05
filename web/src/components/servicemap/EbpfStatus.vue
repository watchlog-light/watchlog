<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Agents without eBPF flows: why, and the command that turns it on (ADR-107). Agents
// with the same cause and fix are one group, so a DaemonSet shows one command.
import { TriangleAlert } from '@lucide/vue';
import type { ServiceMap } from '@watchlog/api-types';
import { computed } from 'vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';

type Agent = ServiceMap['agents'][number];

// A Docker fleet's topology is its Compose networks and their containers.
const props = defineProps<{ agents: Agent[]; mode: ServiceMap['mode']; docker?: boolean }>();

const off = computed(() => props.agents.filter((a) => a.ebpf !== 'enabled'));
const groups = computed(() => {
  const by = new Map<string, { nodes: string[]; agent: Agent }>();
  for (const a of off.value) {
    const key = `${a.cause}\u0000${a.reason}\u0000${a.fix}`;
    const g = by.get(key);
    if (g) g.nodes.push(a.node);
    else by.set(key, { nodes: [a.node], agent: a });
  }
  return [...by.values()];
});
</script>

<template>
  <div
    v-if="mode === 'topology' || off.length"
    class="flex items-start gap-3 rounded-card border border-border bg-surface-1 p-4"
    role="status"
    :data-testid="mode === 'topology' ? 'topology-only' : 'ebpf-partial'"
  >
    <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
    <div class="min-w-0 flex-1 text-13">
      <template v-if="mode === 'topology'">
        <p class="font-semibold text-text">{{ $t('serviceMap.topology.title') }}</p>
        <p class="mt-0.5 text-text-muted">
          {{
            $t(docker ? 'serviceMap.topology.descriptionDocker' : 'serviceMap.topology.description')
          }}
        </p>
      </template>
      <template v-else>
        <p class="font-semibold text-text">
          {{ $t('serviceMap.ebpf.partialTitle', { n: off.length, total: agents.length }) }}
        </p>
        <p class="mt-0.5 text-text-muted">{{ $t('serviceMap.ebpf.partialDescription') }}</p>
      </template>
      <ul v-if="groups.length" class="mt-3 flex flex-col gap-3">
        <li v-for="g in groups" :key="g.nodes.join(',')" data-testid="ebpf-reason">
          <p class="text-12">
            <span class="font-medium text-text">{{ g.nodes.join(', ') }}</span>
            <span class="text-text-muted">
              · {{ $t(`serviceMap.ebpf.cause.${g.agent.cause ?? 'outdated'}`) }}</span
            >
          </p>
          <p v-if="g.agent.reason" class="mt-0.5 font-mono text-12 text-text-muted">
            {{ g.agent.reason }}
          </p>
          <p
            v-if="g.agent.cause === 'permission' || g.agent.cause === 'kernel'"
            class="mt-0.5 text-12 text-text-muted"
          >
            {{ $t(`serviceMap.ebpf.hint.${g.agent.cause}`) }}
          </p>
          <div v-if="g.agent.fix" class="mt-2" data-testid="ebpf-fix">
            <CodeBlock :label="$t('serviceMap.ebpf.fixLabel')" :code="g.agent.fix" />
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
