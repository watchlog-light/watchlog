<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronDown, ChevronRight } from '@lucide/vue';
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import ResourceBar from '@/components/kube/ResourceBar.vue';
import SparkLine from '@/components/overview/SparkLine.vue';
import HighlightText from '@/components/ui/HighlightText.vue';
import { useVirtualRows } from '@/composables/useVirtualRows';
import { isRunning, STANDALONE, type ContainerRow } from '@/lib/containers';
import { exitMeaning, reasonLine } from '@/lib/diagnosis';
import { formatDateTime } from '@/lib/format';
import { values } from '@/lib/overview';
import { since } from '@/lib/time';
import { groupByNamespace, restartsHigh, shortImage } from '@/lib/workloads';

// Containers grouped by Compose project, problem groups first (the Workloads page's
// design for Docker). Running containers show a green dot; problem rows a badge and the
// diagnosis line. A click shows the last health probes and the last exit.
const props = withDefaults(
  defineProps<{
    containers: ContainerRow[];
    range: number;
    terms?: string[];
    showHost?: boolean;
  }>(),
  { terms: () => [], showHost: true },
);
const { t } = useI18n();
const collapsed = reactive(new Set<string>());
const open = ref<string | null>(null);
const groups = computed(() => groupByNamespace([...props.containers]));

type Item =
  | { type: 'ns'; key: string; namespace: string; count: number; problems: number }
  | { type: 'row'; key: string; c: ContainerRow }
  | { type: 'exp'; key: string; c: ContainerRow };
const items = computed<Item[]>(() =>
  groups.value.flatMap((g) => [
    {
      type: 'ns' as const,
      key: `ns:${g.namespace}`,
      namespace: g.namespace,
      count: g.rows.length,
      problems: g.problems,
    },
    ...(collapsed.has(g.namespace)
      ? []
      : g.rows.flatMap((c) => [
          { type: 'row' as const, key: c.key, c },
          ...(open.value === c.key ? [{ type: 'exp' as const, key: `exp:${c.key}`, c }] : []),
        ])),
  ]),
);
const { body, shown, measure } = useVirtualRows(items, (it) =>
  it.type === 'ns' ? 38 : it.type === 'exp' ? 180 : it.c.problem ? 66 : 50,
);
const toggleNs = (ns: string) => (collapsed.has(ns) ? collapsed.delete(ns) : collapsed.add(ns));
const toggle = (c: ContainerRow) => (open.value = open.value === c.key ? null : c.key);
const reason = (c: ContainerRow) => (c.problem ? (reasonLine(c, t) ?? c.problem.reason) : null);
const link = (c: ContainerRow) => ({
  name: 'docker-container',
  params: { host: c.host, name: c.name },
});
const meaning = (code: number) => {
  const m = exitMeaning(code);
  return t(m.key, m.params ?? {});
};
</script>

<template>
  <div class="overflow-x-auto rounded-[12px] border border-border bg-surface-1">
    <table class="tbl" data-testid="container-list">
      <colgroup>
        <col class="w-[24%]" />
        <col class="w-[120px]" />
        <col class="w-[86px]" />
        <col class="w-[140px]" />
        <col class="w-[140px]" />
        <col class="w-[110px]" />
        <col />
        <col v-if="showHost" class="w-[13%]" />
        <col class="w-[84px]" />
      </colgroup>
      <thead>
        <tr>
          <th>{{ $t('docker.list.columns.name') }}</th>
          <th>{{ $t('docker.list.columns.status') }}</th>
          <th class="num">{{ $t('docker.list.columns.restarts') }}</th>
          <th>{{ $t('docker.list.columns.cpu') }}</th>
          <th>{{ $t('docker.list.columns.memory') }}</th>
          <th>{{ $t('docker.list.columns.trend') }}</th>
          <th>{{ $t('docker.list.columns.image') }}</th>
          <th v-if="showHost">{{ $t('docker.list.columns.host') }}</th>
          <th class="num">{{ $t('docker.list.columns.up') }}</th>
        </tr>
      </thead>
      <tbody ref="body">
        <tr v-if="shown.pad[0]" aria-hidden="true">
          <td colspan="9" class="pad" :style="{ height: `${shown.pad[0]}px` }" />
        </tr>
        <template v-for="{ item, index } in shown.items" :key="item.key">
          <tr
            v-if="item.type === 'ns'"
            :ref="measure"
            :data-index="index"
            class="ns"
            data-testid="ns-row"
          >
            <td colspan="9">
              <button
                type="button"
                class="flex w-full items-center gap-2 text-left"
                :aria-expanded="!collapsed.has(item.namespace)"
                @click="toggleNs(item.namespace)"
              >
                <component
                  :is="collapsed.has(item.namespace) ? ChevronRight : ChevronDown"
                  class="size-3.5 text-text-subtle"
                  aria-hidden="true"
                />
                <span class="font-semibold text-text">
                  <template v-if="item.namespace === STANDALONE">{{
                    $t('docker.list.standalone')
                  }}</template>
                  <HighlightText v-else :text="item.namespace" :terms="terms" />
                </span>
                <span class="text-text-subtle">
                  · {{ $t('docker.list.count', { n: item.count }, item.count) }}
                </span>
                <span v-if="item.problems" class="pill crit" data-testid="ns-attention">
                  ✕ {{ $t('kube.workloads.needAttention', { n: item.problems }, item.problems) }}
                </span>
                <span v-else class="pill ok">✓ {{ $t('kube.workloads.allHealthy') }}</span>
              </button>
            </td>
          </tr>
          <tr
            v-else-if="item.type === 'row'"
            :ref="measure"
            :data-index="index"
            class="w"
            :class="{
              attn: item.c.problem?.severity === 'critical',
              warn: item.c.problem?.severity === 'warning',
            }"
            data-testid="container-row"
            @click="toggle(item.c)"
          >
            <td>
              <button
                type="button"
                class="block max-w-full truncate text-left font-medium text-text"
                :aria-expanded="open === item.key"
                @click.stop="toggle(item.c)"
              >
                <HighlightText :text="item.c.name" :terms="terms" />
              </button>
              <p
                v-if="reason(item.c)"
                class="line-clamp-2 text-12"
                :class="item.c.problem?.severity === 'critical' ? 'text-critical' : 'text-warning'"
                data-testid="container-reason"
              >
                {{ reason(item.c) }}
              </p>
            </td>
            <td>
              <span
                v-if="item.c.problem"
                class="pill"
                :class="item.c.problem.severity === 'critical' ? 'crit' : 'warn'"
                data-testid="health-badge"
                >{{ item.c.problem.severity === 'critical' ? '✕' : '▲' }}
                {{ $t(`docker.list.problem.${item.c.problem.kind}`) }}</span
              >
              <span
                v-else
                class="dot"
                :class="isRunning(item.c) ? 'bg-ok' : 'bg-subtle'"
                role="img"
                :aria-label="$t(isRunning(item.c) ? 'docker.list.running' : 'docker.list.stopped')"
                :title="item.c.status"
                data-testid="health-dot"
              />
            </td>
            <td class="num" :class="restartsHigh(item.c.restartsInRange, range) && 'text-critical'">
              <template v-if="item.c.restartsInRange === null">{{ item.c.restartCount }}</template>
              <template v-else>
                <span v-if="restartsHigh(item.c.restartsInRange, range)" aria-hidden="true">▲ </span
                >{{ item.c.restartsInRange }}
              </template>
            </td>
            <td>
              <ResourceBar
                :usage="item.c.cpuCores"
                :request="null"
                :limit="item.c.cpuLimitCores"
                unit="cores"
                reference="limit"
              />
            </td>
            <td>
              <ResourceBar
                :usage="item.c.memoryBytes"
                :request="null"
                :limit="item.c.memoryLimitBytes"
                unit="bytes"
                reference="limit"
              />
            </td>
            <td>
              <SparkLine
                v-if="item.c.cpuSeries.length"
                size="row"
                :values="values(item.c.cpuSeries)"
                :color-token="item.c.problem?.severity === 'critical' ? '--critical' : '--info'"
              />
            </td>
            <td class="img" :title="item.c.image">
              <span class="block truncate"
                ><HighlightText :text="shortImage(item.c.image)" :terms="terms"
              /></span>
            </td>
            <td v-if="showHost" class="truncate text-text-subtle">
              <HighlightText :text="item.c.host" :terms="terms" />
            </td>
            <td class="num text-text-subtle">
              {{ item.c.startedAt && isRunning(item.c) ? since(item.c.startedAt) : '–' }}
            </td>
          </tr>
          <tr v-else :ref="measure" :data-index="index" class="exp" data-testid="container-detail">
            <td colspan="9">
              <div class="flex flex-col gap-1.5 text-12">
                <p v-if="item.c.finishedAt || item.c.exitCode" data-testid="last-exit">
                  <span class="text-text-muted">{{ $t('docker.list.lastExit') }}</span>
                  {{
                    $t('docker.list.exit', {
                      code: item.c.exitCode,
                      meaning: meaning(item.c.exitCode),
                    })
                  }}
                  <template v-if="item.c.oomKilled"> · {{ $t('docker.diagnosis.oom') }}</template>
                  <template v-if="item.c.finishedAt">
                    · {{ formatDateTime(item.c.finishedAt) }}</template
                  >
                  <template v-if="item.c.stateError"> · {{ item.c.stateError }}</template>
                </p>
                <template v-if="item.c.healthDetail?.probes.length">
                  <p class="text-text-muted">{{ $t('docker.list.probes') }}</p>
                  <div
                    v-for="p in item.c.healthDetail.probes.slice(-5).reverse()"
                    :key="p.start"
                    class="probe"
                    data-testid="probe"
                  >
                    <span class="font-mono text-text-subtle">{{ since(p.end) }}</span>
                    <span :class="p.exitCode === 0 ? 'text-ok' : 'text-critical'"
                      >{{ p.exitCode === 0 ? '✓' : '✕' }}
                      {{ $t('docker.list.exitCode', { code: p.exitCode }) }}</span
                    >
                    <span class="truncate font-mono text-text-muted" :title="p.output ?? ''">{{
                      p.output ?? '–'
                    }}</span>
                  </div>
                </template>
                <p
                  v-if="
                    !item.c.healthDetail?.probes.length && !item.c.finishedAt && !item.c.exitCode
                  "
                  class="text-text-subtle"
                >
                  {{ $t('docker.list.nothingYet') }}
                </p>
              </div>
              <RouterLink
                :to="link(item.c)"
                class="mt-2 inline-block text-12 text-primary hover:underline"
                data-testid="open-container"
                >{{ $t('docker.list.open', { id: `${item.c.host}/${item.c.name}` }) }} →</RouterLink
              >
            </td>
          </tr>
        </template>
        <tr v-if="shown.pad[1]" aria-hidden="true">
          <td colspan="9" class="pad" :style="{ height: `${shown.pad[1]}px` }" />
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.tbl {
  width: 100%;
  min-width: 1060px;
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
tr.ns td {
  padding: 8px 12px;
  background: var(--surface-2);
}
tr.w {
  cursor: pointer;
}
tr.w:hover td {
  background: color-mix(in srgb, var(--text) 2%, transparent);
}
tr.attn td:first-child {
  box-shadow: inset 3px 0 0 var(--critical);
}
tr.warn td:first-child {
  box-shadow: inset 3px 0 0 var(--warning);
}
tr.exp td {
  padding: 10px 12px 12px 36px;
  background: var(--bg);
}
.img {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
}
.probe {
  display: grid;
  grid-template-columns: 64px 120px minmax(0, 1fr);
  gap: 12px;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
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
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.bg-ok {
  background: var(--ok);
}
.bg-subtle {
  background: var(--text-subtle);
}
.text-ok {
  color: var(--ok);
}
.text-critical {
  color: var(--critical);
}
.text-warning {
  color: var(--warning);
}
</style>
