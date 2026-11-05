<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { KubePod } from '@watchlog/api-types';
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import HighlightText from '@/components/ui/HighlightText.vue';
import { useVirtualRows } from '@/composables/useVirtualRows';
import { since } from '@/lib/time';
import { severityOf } from '@/lib/workloads';
import ResourceBar from './ResourceBar.vue';

// Pods in the Workloads page's style: failing pods first, then pending ones, then by
// namespace and name; node and last termination shown. Long lists are virtualised.
const props = withDefaults(defineProps<{ pods: KubePod[]; terms?: string[] }>(), {
  terms: () => [],
});
const RANK: Record<string, number> = { critical: 0, warning: 1 };
const rank = (p: KubePod) => RANK[severityOf(p) ?? ''] ?? 2;
const rows = computed(() =>
  [...props.pods].sort(
    (a, b) =>
      rank(a) - rank(b) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name),
  ),
);

const keyed = computed(() => rows.value.map((p) => ({ key: `${p.namespace}/${p.name}`, p })));
const { body, shown } = useVirtualRows(keyed, () => 50);
</script>

<template>
  <div class="overflow-x-auto rounded-[12px] border border-border bg-surface-1">
    <table class="tbl" data-testid="pod-table">
      <colgroup>
        <col class="w-[26%]" />
        <col class="w-[170px]" />
        <col class="w-[14%]" />
        <col class="w-[86px]" />
        <col class="w-[140px]" />
        <col class="w-[140px]" />
        <col />
        <col class="w-[84px]" />
      </colgroup>
      <thead>
        <tr>
          <th>{{ $t('kube.pods.columns.name') }}</th>
          <th>{{ $t('kube.pods.columns.status') }}</th>
          <th>{{ $t('kube.pods.columns.node') }}</th>
          <th class="num">{{ $t('kube.pods.columns.restarts') }}</th>
          <th>{{ $t('kube.pods.columns.cpu') }}</th>
          <th>{{ $t('kube.pods.columns.memory') }}</th>
          <th>{{ $t('kube.pods.columns.lastTermination') }}</th>
          <th class="num">{{ $t('kube.pods.columns.age') }}</th>
        </tr>
      </thead>
      <tbody ref="body">
        <tr v-if="shown.pad[0]" aria-hidden="true">
          <td colspan="8" class="pad" :style="{ height: `${shown.pad[0]}px` }" />
        </tr>
        <tr
          v-for="{ item: { p } } in shown.items"
          :key="`${p.namespace}/${p.name}`"
          :class="{ attn: severityOf(p) === 'critical', warn: severityOf(p) === 'warning' }"
          data-testid="pod-row"
        >
          <td>
            <RouterLink
              :to="{ name: 'pod', params: { namespace: p.namespace, name: p.name } }"
              class="block truncate font-mono text-12 text-text hover:underline"
            >
              <HighlightText :text="`${p.namespace}/${p.name}`" :terms="terms" />
            </RouterLink>
            <p
              v-if="p.workload && p.workloadKind !== 'Pod'"
              class="truncate text-12 text-text-subtle"
            >
              {{ p.workloadKind }} {{ p.workload }}
            </p>
          </td>
          <td>
            <span v-if="p.failing" class="pill crit">✕ {{ p.failing }}</span>
            <span v-else-if="p.phase === 'Pending'" class="pill warn">▲ {{ p.status }}</span>
            <span v-else-if="p.ready || p.phase === 'Succeeded'" class="pill ok"
              >✓ {{ p.status }}</span
            >
            <span v-else class="pill neutral">{{ p.status }}</span>
          </td>
          <td class="truncate text-text-subtle">
            <HighlightText v-if="p.node" :text="p.node" :terms="terms" />
            <template v-else>–</template>
          </td>
          <td class="num" :class="p.restarts > 20 && 'text-critical'">{{ p.restarts }}</td>
          <td>
            <ResourceBar
              :usage="p.cpuCores"
              :request="p.cpuRequestCores || null"
              :limit="p.cpuLimitCores"
              unit="cores"
            />
          </td>
          <td>
            <ResourceBar
              :usage="p.memoryBytes"
              :request="p.memoryRequestBytes || null"
              :limit="p.memoryLimitBytes"
              unit="bytes"
            />
          </td>
          <td class="truncate text-12 text-text-subtle" data-testid="last-termination">
            {{
              p.lastTermination
                ? $t('kube.workloads.lastExit', {
                    reason: p.lastTermination.reason,
                    code: p.lastTermination.exitCode,
                  })
                : '–'
            }}
          </td>
          <td class="num text-text-subtle">{{ p.createdAt ? since(p.createdAt) : '–' }}</td>
        </tr>
        <tr v-if="shown.pad[1]" aria-hidden="true">
          <td colspan="8" class="pad" :style="{ height: `${shown.pad[1]}px` }" />
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.tbl {
  width: 100%;
  min-width: 1100px;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 13px;
}
.tbl th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
}
.tbl td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.tbl td.pad {
  padding: 0;
  border: 0;
}
.tbl .num {
  text-align: right;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
}
tr.attn td:first-child {
  box-shadow: inset 3px 0 0 var(--critical);
}
tr.warn td:first-child {
  box-shadow: inset 3px 0 0 var(--warning);
}
.pill {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pill.crit {
  color: var(--critical);
  background: color-mix(in srgb, var(--critical) 12%, transparent);
}
.pill.warn {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 12%, transparent);
}
.pill.ok {
  color: var(--primary);
  background: var(--primary-soft);
}
.pill.neutral {
  color: var(--text-muted);
  background: var(--surface-3);
}
.text-critical {
  color: var(--critical);
}
</style>
