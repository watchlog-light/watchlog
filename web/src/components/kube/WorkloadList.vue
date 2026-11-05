<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronDown, ChevronRight } from '@lucide/vue';
import type { KubePodList, KubeWorkload } from '@watchlog/api-types';
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { api } from '@/api/client';
import SparkLine from '@/components/overview/SparkLine.vue';
import HighlightText from '@/components/ui/HighlightText.vue';
import { useVirtualRows } from '@/composables/useVirtualRows';
import { values } from '@/lib/overview';
import { since } from '@/lib/time';
import { cronText, groupByNamespace, restartsHigh, shortImage } from '@/lib/workloads';
import PodSquares from './PodSquares.vue';
import ResourceBar from './ResourceBar.vue';

// Workloads grouped by namespace, problems first (ADR-111).
// Healthy rows show a green dot; problem rows a badge and their reason. A click on a row
// shows its pods inline. Long lists are virtualised: only rows near the view are drawn.
const props = withDefaults(
  defineProps<{ workloads: KubeWorkload[]; clusterId: string; range: number; terms?: string[] }>(),
  { terms: () => [] },
);
const { t } = useI18n();

const collapsed = reactive(new Set<string>());
const open = ref<string | null>(null);
const id = (w: KubeWorkload) => `${w.namespace}/${w.kind}/${w.name}`;
const groups = computed(() => groupByNamespace([...props.workloads]));

type Item =
  | { type: 'ns'; key: string; namespace: string; count: number; problems: number }
  | { type: 'row'; key: string; w: KubeWorkload }
  | { type: 'exp'; key: string; w: KubeWorkload };
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
      : g.rows.flatMap((w) => [
          { type: 'row' as const, key: id(w), w },
          ...(open.value === id(w) ? [{ type: 'exp' as const, key: `exp:${id(w)}`, w }] : []),
        ])),
  ]),
);

// Long lists are virtualised (useVirtualRows).
const { body, shown, measure } = useVirtualRows(items, (it) =>
  it.type === 'ns' ? 38 : it.type === 'exp' ? 160 : it.w.problem ? 66 : 50,
);

function toggleNs(ns: string) {
  if (collapsed.has(ns)) collapsed.delete(ns);
  else collapsed.add(ns);
}

// The pods of the open row, loaded when it opens.
const pods = reactive(
  new Map<string, { loading: boolean; error: boolean; list: KubePodList['pods'] }>(),
);
async function toggle(w: KubeWorkload) {
  const k = id(w);
  open.value = open.value === k ? null : k;
  if (open.value !== k || pods.get(k)?.list.length) return;
  pods.set(k, { loading: true, error: false, list: [] });
  try {
    const q = new URLSearchParams({
      namespaces: w.namespace,
      workloadKind: w.kind,
      workload: w.name,
    });
    const r = await api<KubePodList>(`/clusters/${props.clusterId}/pods?${q}`);
    pods.set(k, { loading: false, error: false, list: r.pods });
  } catch {
    pods.set(k, { loading: false, error: true, list: [] });
  }
}

const changed = (w: KubeWorkload) => w.lastRolloutAt ?? w.createdAt;
const imageTitle = (w: KubeWorkload) => w.images.join('\n');
const scale = (w: KubeWorkload) => Math.max(1, w.pods);
const workloadLink = (w: KubeWorkload) => ({
  name: 'workloads',
  query: { view: 'pods', wkind: w.kind, wns: w.namespace, wname: w.name },
});
const runLabel = (w: KubeWorkload) => {
  const parts = [w.schedule ? cronText(w.schedule, t) : ''];
  if (w.lastRun)
    parts.push(
      t(`kube.workloads.lastRun.${w.lastRun.result}`, {
        ago: w.lastRun.at ? since(w.lastRun.at) : '',
      }),
    );
  else parts.push(t('kube.workloads.lastRun.none'));
  return parts.filter(Boolean).join(' · ');
};
</script>

<template>
  <div class="overflow-x-auto rounded-[12px] border border-border bg-surface-1">
    <table class="tbl" data-testid="workload-table">
      <colgroup>
        <col class="w-[26%]" />
        <col class="w-[104px]" />
        <col class="w-[150px]" />
        <col class="w-[86px]" />
        <col class="w-[140px]" />
        <col class="w-[140px]" />
        <col class="w-[110px]" />
        <col />
        <col class="w-[84px]" />
      </colgroup>
      <thead>
        <tr>
          <th>{{ $t('kube.workloads.columns.name') }}</th>
          <th>{{ $t('kube.workloads.columns.health') }}</th>
          <th>{{ $t('kube.workloads.columns.ready') }}</th>
          <th class="num">{{ $t('kube.workloads.columns.restarts') }}</th>
          <th>{{ $t('kube.workloads.columns.cpu') }}</th>
          <th>{{ $t('kube.workloads.columns.memory') }}</th>
          <th>{{ $t('kube.workloads.columns.trend') }}</th>
          <th>{{ $t('kube.workloads.columns.images') }}</th>
          <th class="num">{{ $t('kube.workloads.columns.changed') }}</th>
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
                  <HighlightText :text="item.namespace" :terms="terms" />
                </span>
                <span class="text-text-subtle">
                  · {{ $t('kube.workloads.total.workloads', { n: item.count }, item.count) }}
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
              attn: item.w.problem?.severity === 'critical',
              warn: item.w.problem?.severity === 'warning',
              open: open === item.key,
            }"
            data-testid="workload-row"
            @click="toggle(item.w)"
          >
            <td>
              <button
                type="button"
                class="block max-w-full truncate text-left font-medium text-text"
                :aria-expanded="open === item.key"
                @click.stop="toggle(item.w)"
              >
                <HighlightText :text="item.w.name" :terms="terms" /><span class="kd">{{
                  item.w.kind
                }}</span>
              </button>
              <p
                v-if="item.w.problem"
                class="line-clamp-2 text-12"
                :class="item.w.problem.severity === 'critical' ? 'text-critical' : 'text-warning'"
                data-testid="problem-reason"
              >
                {{ item.w.problem.reason }}
              </p>
            </td>
            <td>
              <span
                v-if="item.w.problem?.severity === 'critical'"
                class="pill crit"
                data-testid="health-badge"
                >✕ {{ $t('kube.workloads.badge.failing') }}</span
              >
              <span v-else-if="item.w.problem" class="pill warn" data-testid="health-badge"
                >▲ {{ $t('kube.workloads.badge.degraded') }}</span
              >
              <span
                v-else-if="item.w.health === 'suspended'"
                class="pill neutral"
                data-testid="health-badge"
                >{{ $t('kube.workloads.health.suspended') }}</span
              >
              <span
                v-else
                class="dot"
                :class="item.w.health === 'progressing' ? 'bg-info' : 'bg-ok'"
                role="img"
                :aria-label="$t(`kube.workloads.health.${item.w.health}`)"
                :title="$t(`kube.workloads.health.${item.w.health}`)"
                data-testid="health-dot"
              />
            </td>
            <td>
              <span
                v-if="item.w.kind === 'CronJob'"
                class="text-12 text-text-muted"
                data-testid="cron"
                >{{ runLabel(item.w) }}</span
              >
              <span
                v-else-if="item.w.kind === 'Job' && item.w.health !== 'progressing'"
                class="text-12 text-text-muted"
                data-testid="job"
                >{{
                  $t(`kube.workloads.job.${item.w.health === 'failed' ? 'failed' : 'complete'}`, {
                    n: item.w.ready ?? 0,
                    of: item.w.desired ?? 1,
                  })
                }}</span
              >
              <PodSquares
                v-else
                :states="item.w.podStates"
                :ready="item.w.ready ?? 0"
                :desired="item.w.desired ?? item.w.podStates.length"
              />
            </td>
            <td class="num" :class="restartsHigh(item.w.restartsInRange, range) && 'text-critical'">
              <template v-if="item.w.restartsInRange === null">–</template>
              <template v-else>
                <span v-if="restartsHigh(item.w.restartsInRange, range)" aria-hidden="true">▲ </span
                >{{ item.w.restartsInRange }}
              </template>
            </td>
            <td>
              <ResourceBar
                :usage="item.w.cpuCores"
                :request="item.w.cpuRequestCores * scale(item.w) || null"
                :limit="item.w.cpuLimitCores === null ? null : item.w.cpuLimitCores * scale(item.w)"
                unit="cores"
              />
            </td>
            <td>
              <ResourceBar
                :usage="item.w.memoryBytes"
                :request="item.w.memoryRequestBytes * scale(item.w) || null"
                :limit="
                  item.w.memoryLimitBytes === null ? null : item.w.memoryLimitBytes * scale(item.w)
                "
                unit="bytes"
              />
            </td>
            <td>
              <SparkLine
                v-if="item.w.cpuSeries.length"
                size="row"
                :values="values(item.w.cpuSeries)"
                :color-token="item.w.problem?.severity === 'critical' ? '--critical' : '--info'"
              />
            </td>
            <td class="img" :title="imageTitle(item.w)">
              <span class="block truncate">
                <HighlightText :text="shortImage(item.w.images[0] ?? '')" :terms="terms" />
                <span v-if="item.w.images.length > 1" class="text-text-subtle">
                  +{{ item.w.images.length - 1 }}</span
                >
              </span>
            </td>
            <td class="num text-text-subtle">
              {{ changed(item.w) ? since(changed(item.w)!) : '–' }}
            </td>
          </tr>
          <tr v-else :ref="measure" :data-index="index" class="exp" data-testid="workload-pods">
            <td colspan="9">
              <p v-if="pods.get(id(item.w))?.loading" class="text-12 text-text-subtle">
                {{ $t('common.loading') }}
              </p>
              <p v-else-if="pods.get(id(item.w))?.error" class="text-12 text-critical">
                {{ $t('kube.workloads.podsError') }}
              </p>
              <div v-else class="flex flex-col gap-1.5">
                <div
                  v-for="p in pods.get(id(item.w))?.list ?? []"
                  :key="p.name"
                  class="pr"
                  data-testid="expanded-pod"
                >
                  <RouterLink
                    :to="{ name: 'pod', params: { namespace: p.namespace, name: p.name } }"
                    class="truncate font-mono text-text hover:underline"
                    >{{ p.name }}</RouterLink
                  >
                  <span>
                    <span v-if="p.failing" class="pill crit">✕ {{ p.status }}</span>
                    <span v-else-if="p.ready" class="pill ok">✓ {{ p.status }}</span>
                    <span v-else class="pill warn">▲ {{ p.status }}</span>
                  </span>
                  <span class="truncate text-text-subtle">{{
                    p.node
                      ? $t('kube.workloads.onNode', { node: p.node })
                      : $t('kube.workloads.unscheduled')
                  }}</span>
                  <span class="font-mono text-text-subtle tabular-nums">{{
                    $t('kube.workloads.restarts', { n: p.restarts }, p.restarts)
                  }}</span>
                  <span class="truncate text-text-subtle">{{
                    p.lastTermination
                      ? $t('kube.workloads.lastExit', {
                          reason: p.lastTermination.reason,
                          code: p.lastTermination.exitCode,
                        })
                      : p.startedAt
                        ? $t('kube.workloads.up', { d: since(p.startedAt) })
                        : '–'
                  }}</span>
                </div>
                <p v-if="!pods.get(id(item.w))?.list.length" class="text-12 text-text-subtle">
                  {{ $t('kube.workloads.noPods') }}
                </p>
              </div>
              <RouterLink
                :to="workloadLink(item.w)"
                class="mt-2 inline-block text-12 text-primary hover:underline"
                data-testid="open-workload"
                >{{
                  $t('kube.workloads.open', {
                    kind: item.w.kind,
                    id: `${item.w.namespace}/${item.w.name}`,
                  })
                }}
                →</RouterLink
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
  min-width: 1080px;
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
  font-size: 13px;
}
tr.w {
  cursor: pointer;
}
tr.w:hover td,
tr.w.open td {
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
.kd {
  margin-left: 6px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-subtle);
  font-size: 11px;
  font-weight: 400;
}
.img {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
}
.pr {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) 160px minmax(0, 1fr) 90px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  font-size: 12px;
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
.pill.neutral {
  color: var(--text-muted);
  background: var(--surface-3);
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
.bg-info {
  background: var(--info);
}
.text-critical {
  color: var(--critical);
}
.text-warning {
  color: var(--warning);
}
</style>
