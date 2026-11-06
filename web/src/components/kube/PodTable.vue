<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { KubePod } from '@watchlog/api-types';
import { useRouter } from 'vue-router';
import HighlightText from '@/components/ui/HighlightText.vue';
import { podTone } from '@/lib/kube';
import { since } from '@/lib/time';
import { formatValue } from '@/lib/units';
import TonePill from './TonePill.vue';

// Pods (SPEC §4.3): status as kubectl shows it, restarts with the last termination
// reason and exit code, usage against requests and limits.
withDefaults(defineProps<{ pods: KubePod[]; showNode?: boolean; terms?: string[] }>(), {
  showNode: true,
  terms: () => [],
});
const router = useRouter();
const linked = router.hasRoute('pod');
</script>

<template>
  <div class="overflow-x-auto rounded-card border border-border bg-surface-1">
    <table class="rt w-full min-w-[880px] text-left text-13" data-testid="pod-table">
      <thead class="bg-surface-2 text-12 text-text-muted">
        <tr>
          <th class="px-4 py-2 font-medium">{{ $t('kube.pods.columns.name') }}</th>
          <th class="px-4 py-2 font-medium">{{ $t('kube.pods.columns.status') }}</th>
          <th class="px-4 py-2 text-right font-medium">{{ $t('kube.pods.columns.ready') }}</th>
          <th class="px-4 py-2 font-medium">{{ $t('kube.pods.columns.restarts') }}</th>
          <th class="px-4 py-2 text-right font-medium">{{ $t('kube.pods.columns.cpu') }}</th>
          <th class="px-4 py-2 text-right font-medium">{{ $t('kube.pods.columns.memory') }}</th>
          <th v-if="showNode" class="px-4 py-2 font-medium">{{ $t('kube.pods.columns.node') }}</th>
          <th class="px-4 py-2 text-right font-medium">{{ $t('kube.pods.columns.age') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="p in pods"
          :key="`${p.namespace}/${p.name}`"
          class="border-t border-border align-top"
          data-testid="pod-row"
        >
          <td class="c-name max-w-80 px-4 py-2.5">
            <component
              :is="linked ? 'RouterLink' : 'span'"
              :to="
                linked
                  ? { name: 'pod', params: { namespace: p.namespace, name: p.name } }
                  : undefined
              "
              class="block truncate font-medium text-text hover:underline max-lg:leading-11"
            >
              <HighlightText :text="p.name" :terms="terms" />
            </component>
            <p class="truncate text-12 text-text-muted">
              <HighlightText :text="p.namespace" :terms="terms" />
              <template v-if="p.workload && p.workloadKind !== 'Pod'">
                · {{ p.workloadKind }} {{ p.workload }}</template
              >
            </p>
          </td>
          <td class="px-4 py-2.5" :data-label="$t('kube.pods.columns.status')">
            <TonePill :tone="podTone(p.status)" :label="p.status" />
          </td>
          <td
            class="px-4 py-2.5 text-right font-mono tabular"
            :data-label="$t('kube.pods.columns.ready')"
          >
            {{ p.readyContainers }}/{{ p.totalContainers }}
          </td>
          <td class="px-4 py-2.5" :data-label="$t('kube.pods.columns.restarts')">
            <span class="font-mono tabular">{{ p.restarts }}</span>
            <p
              v-if="p.lastTermination"
              class="text-12 text-text-muted"
              data-testid="last-termination"
            >
              {{
                $t('kube.pods.lastTermination', {
                  reason: p.lastTermination.reason,
                  code: p.lastTermination.exitCode,
                })
              }}
            </p>
          </td>
          <td
            class="px-4 py-2.5 text-right font-mono tabular"
            :data-label="$t('kube.pods.columns.cpu')"
          >
            {{ formatValue(p.cpuCores, 'cores') }}
            <p class="text-12 text-text-subtle">
              {{
                $t('kube.pods.reqLimit', {
                  req: p.cpuRequestCores ? formatValue(p.cpuRequestCores, 'cores') : '–',
                  limit: formatValue(p.cpuLimitCores, 'cores'),
                })
              }}
            </p>
          </td>
          <td
            class="px-4 py-2.5 text-right font-mono tabular"
            :data-label="$t('kube.pods.columns.memory')"
          >
            {{ formatValue(p.memoryBytes, 'bytes') }}
            <p class="text-12 text-text-subtle">
              {{
                $t('kube.pods.reqLimit', {
                  req: p.memoryRequestBytes ? formatValue(p.memoryRequestBytes, 'bytes') : '–',
                  limit: formatValue(p.memoryLimitBytes, 'bytes'),
                })
              }}
            </p>
          </td>
          <td v-if="showNode" class="px-4 py-2.5" :data-label="$t('kube.pods.columns.node')">
            <RouterLink
              v-if="p.node"
              :to="{ name: 'node', params: { name: p.node } }"
              class="text-text-muted hover:underline max-lg:inline-block max-lg:leading-11"
              >{{ p.node }}</RouterLink
            >
            <span v-else class="text-text-subtle">–</span>
          </td>
          <td
            class="px-4 py-2.5 text-right font-mono text-text-muted tabular"
            :data-label="$t('kube.pods.columns.age')"
          >
            {{ p.createdAt ? since(p.createdAt) : '–' }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
/* Phones: each pod is a card (name, then labelled fields in two columns). */
@media (max-width: 767px) {
  .rt {
    min-width: 0;
  }
  .rt thead {
    display: none;
  }
  .rt,
  .rt tbody,
  .rt td {
    display: block;
  }
  .rt tr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px 16px;
    padding: 4px 12px 12px;
  }
  .rt tr:first-child {
    border-top: 0;
  }
  .rt td {
    min-width: 0;
    max-width: none;
    padding: 0;
    text-align: left;
  }
  .rt td.c-name {
    grid-column: 1 / -1;
  }
  .rt td[data-label]::before {
    display: block;
    margin-bottom: 2px;
    color: var(--text-subtle);
    content: attr(data-label);
    font-family: var(--font-sans, inherit);
    font-size: var(--text-11);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
}
</style>
