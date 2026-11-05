<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowDown, ArrowUp } from '@lucide/vue';
import { computed, ref } from 'vue';
import HighlightText from '@/components/ui/HighlightText.vue';
import { share } from '@/lib/kube';
import type { NodeModel } from '@/lib/nodes';
import { since } from '@/lib/time';
import { formatValue } from '@/lib/units';
import KubeletTlsBadge from './KubeletTlsBadge.vue';
import TonePill from './TonePill.vue';
import UsageMeter from './UsageMeter.vue';

// Nodes (SPEC §4.2): sortable by name, CPU, memory, disk, pods and age.
const props = withDefaults(defineProps<{ nodes: NodeModel[]; terms?: string[] }>(), {
  terms: () => [],
});

type SortKey = 'name' | 'cpu' | 'memory' | 'disk' | 'pods' | 'age';
const sortKey = ref<SortKey>('name');
const descending = ref(false);

const value = (n: NodeModel, key: SortKey): number | string => {
  switch (key) {
    case 'name':
      return n.name;
    case 'cpu':
      return share(n.cpu.usageCores, n.cpu.allocatableCores) ?? -1;
    case 'memory':
      return share(n.memory.usageBytes, n.memory.allocatableBytes) ?? -1;
    case 'disk':
      return n.diskUtilization ?? -1;
    case 'pods':
      return n.pods.count;
    case 'age':
      return n.bootTime ? -n.bootTime * 1000 : n.createdAt ? -Date.parse(n.createdAt) : 0;
  }
};
const sorted = computed(() =>
  [...props.nodes].sort((a, b) => {
    const x = value(a, sortKey.value);
    const y = value(b, sortKey.value);
    const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
    return descending.value ? -c : c;
  }),
);
function sortBy(key: SortKey) {
  if (sortKey.value === key) descending.value = !descending.value;
  else {
    sortKey.value = key;
    descending.value = key !== 'name';
  }
}
const ariaSort = (key: SortKey) =>
  sortKey.value === key ? (descending.value ? 'descending' : 'ascending') : 'none';
const tone = (n: NodeModel) =>
  n.status === 'Ready'
    ? n.unschedulable
      ? 'warning'
      : 'ok'
    : n.status === 'NotReady'
      ? 'critical'
      : 'warning';
// Docker hosts: containers instead of pods, uptime instead of age.
const hosts = computed(() => props.nodes[0]?.kind === 'host');
const COLUMNS = computed<{ key: SortKey; label: string; right?: boolean }[]>(() => [
  { key: 'cpu', label: 'kube.nodes.columns.cpu' },
  { key: 'memory', label: 'kube.nodes.columns.memory' },
  { key: 'disk', label: 'kube.nodes.columns.disk', right: true },
  {
    key: 'pods',
    label: hosts.value ? 'docker.hosts.columns.containers' : 'kube.nodes.columns.pods',
    right: true,
  },
  {
    key: 'age',
    label: hosts.value ? 'docker.hosts.columns.up' : 'kube.nodes.columns.age',
    right: true,
  },
]);
</script>

<template>
  <div class="overflow-x-auto rounded-card border border-border bg-surface-1">
    <table class="w-full min-w-[960px] text-left text-13" data-testid="node-table">
      <thead class="bg-surface-2 text-12 text-text-muted">
        <tr>
          <th class="px-4 py-2 font-medium" :aria-sort="ariaSort('name')">
            <button
              type="button"
              class="inline-flex items-center gap-1 hover:text-text"
              @click="sortBy('name')"
            >
              {{ $t('kube.nodes.columns.name') }}
              <component
                :is="descending ? ArrowDown : ArrowUp"
                v-if="sortKey === 'name'"
                class="size-3"
                aria-hidden="true"
              />
            </button>
          </th>
          <th class="px-4 py-2 font-medium">{{ $t('kube.nodes.columns.status') }}</th>
          <th
            v-for="c in COLUMNS"
            :key="c.key"
            :class="['px-4 py-2 font-medium', c.right ? 'text-right' : '']"
            :aria-sort="ariaSort(c.key)"
          >
            <button
              type="button"
              class="inline-flex items-center gap-1 hover:text-text"
              @click="sortBy(c.key)"
            >
              {{ $t(c.label) }}
              <component
                :is="descending ? ArrowDown : ArrowUp"
                v-if="sortKey === c.key"
                class="size-3"
                aria-hidden="true"
              />
            </button>
          </th>
          <th class="px-4 py-2 font-medium">{{ $t('kube.nodes.columns.conditions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="n in sorted"
          :key="n.name"
          class="border-t border-border align-top"
          data-testid="node-row"
        >
          <td class="px-4 py-2.5">
            <RouterLink :to="n.link" class="font-medium text-text hover:underline">
              <HighlightText :text="n.name" :terms="terms" />
            </RouterLink>
            <p class="text-12 text-text-muted">
              <HighlightText :text="n.roles.join(', ') || $t('kube.nodes.worker')" :terms="terms" />
              · <HighlightText :text="n.kubeletVersion ?? '–'" :terms="terms" />
            </p>
            <p class="truncate text-12 text-text-subtle">
              {{ n.osImage ?? '–' }} · {{ n.kernelVersion ?? '–' }}
            </p>
          </td>
          <td class="px-4 py-2.5">
            <div class="flex flex-col items-start gap-1">
              <TonePill :tone="tone(n)" :label="$t(`kube.nodes.status.${n.status}`)" />
              <TonePill v-if="n.unschedulable" tone="warning" :label="$t('kube.nodes.cordoned')" />
              <TonePill
                v-if="n.agent.status !== 'active'"
                tone="neutral"
                :label="$t(`kube.nodes.agent.${n.agent.status}`)"
              />
              <KubeletTlsBadge v-if="n.agent.kubeletTls === 'unverified'" compact />
            </div>
          </td>
          <td class="w-40 px-4 py-2.5">
            <UsageMeter
              :usage="n.cpu.usageCores"
              :requests="n.cpu.requestsCores"
              :allocatable="n.cpu.allocatableCores"
              unit="cores"
              compact
            />
          </td>
          <td class="w-40 px-4 py-2.5">
            <UsageMeter
              :usage="n.memory.usageBytes"
              :requests="n.memory.requestsBytes"
              :allocatable="n.memory.allocatableBytes"
              unit="bytes"
              compact
            />
          </td>
          <td class="px-4 py-2.5 text-right font-mono tabular">
            {{ formatValue(n.diskUtilization, 'ratio') }}
          </td>
          <td class="px-4 py-2.5 text-right font-mono tabular">
            {{ n.pods.count }}<span class="text-text-subtle"> / {{ n.pods.capacity ?? '–' }}</span>
          </td>
          <td class="px-4 py-2.5 text-right font-mono text-text-muted tabular">
            {{
              n.bootTime
                ? since(new Date(n.bootTime * 1000).toISOString())
                : n.createdAt
                  ? since(n.createdAt)
                  : '–'
            }}
          </td>
          <td class="px-4 py-2.5">
            <div class="flex flex-wrap gap-1">
              <TonePill
                v-for="c in n.conditions.filter((x) => x.bad)"
                :key="c.type"
                :tone="c.type === 'Ready' ? 'critical' : 'warning'"
                :label="c.type === 'Ready' ? $t('kube.nodes.status.NotReady') : c.type"
              />
              <span v-if="!n.conditions.some((x) => x.bad)" class="text-12 text-text-muted">{{
                $t('kube.nodes.conditionsOk')
              }}</span>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
