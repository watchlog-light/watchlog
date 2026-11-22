<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronDown, ChevronRight } from '@lucide/vue';
import { computed, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import SparkLine from '@/components/overview/SparkLine.vue';
import ResourceBar from '@/components/kube/ResourceBar.vue';
import HighlightText from '@/components/ui/HighlightText.vue';
import { values } from '@/lib/overview';
import type { ServerGroup, TreeRow } from '@/lib/server-workloads';
import { since } from '@/lib/time';

// The fleet's workloads as the Kubernetes Workloads page shows a cluster's (ADR-124): a
// collapsible group per server ("N need attention"), services with their process groups under
// them, pm2's apps under pm2, containers under their Compose project; status, instances,
// restarts, CPU and memory against their limits, the CPU trend, what it runs and its last
// change. A row opens the workload's page; a Compose project, its containers.
const props = withDefaults(defineProps<{ servers: ServerGroup[]; terms?: string[] }>(), {
  terms: () => [],
});
const { t } = useI18n();
const router = useRouter();
const collapsed = reactive(new Set<string>());
const toggleServer = (s: string) => (collapsed.has(s) ? collapsed.delete(s) : collapsed.add(s));

const kindTag = (r: TreeRow) =>
  r.kind === 'compose'
    ? t('servers.kindTag.compose')
    : r.kind === 'process' && r.w.note
      ? t('servers.kindTag.processBy', {
          by: t(`servers.by.${r.w.note}`, r.w.note),
        })
      : t(`servers.source.${r.kind}`);
const reason = (r: TreeRow) => {
  const p = r.w.problem;
  if (!p) return '';
  const what = t(`servers.problem.${p.kind}`);
  return p.code != null ? t('servers.fleetWorkloads.reasonCode', { what, code: p.code }) : what;
};
const instances = (r: TreeRow) =>
  r.w.instances == null
    ? '–'
    : r.w.expected != null
      ? `${r.w.instances}/${r.w.expected}`
      : String(r.w.instances);
function open(r: TreeRow) {
  if (r.kind === 'compose') void router.push({ name: 'containers', query: { project: r.w.name } });
  else
    void router.push({
      name: 'server-workload',
      params: { server: r.w.server, workload: r.w.id },
    });
}
const count = computed(() => props.servers.reduce((n, s) => n + s.rows.length, 0));
</script>

<template>
  <div class="overflow-x-auto rounded-[12px] border border-border bg-surface-1">
    <table class="tbl" data-testid="server-workload-table" :aria-rowcount="count">
      <colgroup>
        <col class="w-[26%]" />
        <col class="w-[104px]" />
        <col class="w-[92px]" />
        <col class="w-[112px]" />
        <col class="w-[140px]" />
        <col class="w-[140px]" />
        <col class="w-[110px]" />
        <col />
        <col class="w-[84px]" />
      </colgroup>
      <thead>
        <tr>
          <th>{{ $t('servers.fleetWorkloads.columns.workload') }}</th>
          <th>{{ $t('servers.fleetWorkloads.columns.status') }}</th>
          <th>{{ $t('servers.fleetWorkloads.columns.instances') }}</th>
          <th class="num">{{ $t('servers.fleetWorkloads.columns.restarts') }}</th>
          <th>{{ $t('servers.fleetWorkloads.columns.cpu') }}</th>
          <th>{{ $t('servers.fleetWorkloads.columns.memory') }}</th>
          <th>{{ $t('servers.fleetWorkloads.columns.trend') }}</th>
          <th>{{ $t('servers.fleetWorkloads.columns.runs') }}</th>
          <th class="num">{{ $t('servers.fleetWorkloads.columns.changed') }}</th>
        </tr>
      </thead>
      <tbody v-for="g in servers" :key="g.server">
        <tr class="ns" data-testid="server-group">
          <td colspan="9">
            <button
              type="button"
              class="flex w-full items-center gap-2 text-left max-lg:min-h-11"
              :aria-expanded="!collapsed.has(g.server)"
              @click="toggleServer(g.server)"
            >
              <component
                :is="collapsed.has(g.server) ? ChevronRight : ChevronDown"
                class="size-4 text-text-muted"
                aria-hidden="true"
              />
              <span class="font-mono font-medium text-text">{{ g.server }}</span>
              <span class="text-text-subtle">
                ·
                {{ $t('servers.fleetWorkloads.total', { n: g.rows.length }, g.rows.length) }}
              </span>
              <span v-if="g.attention" class="pill crit" data-testid="server-attention">
                ✕ {{ $t('kube.workloads.needAttention', { n: g.attention }, g.attention) }}
              </span>
              <span v-else class="pill ok">✓ {{ $t('kube.workloads.allHealthy') }}</span>
            </button>
          </td>
        </tr>
        <template v-if="!collapsed.has(g.server)">
          <tr
            v-for="r in g.rows"
            :key="r.id"
            class="w"
            :class="{
              attn: r.w.problem?.severity === 'critical',
              warn: r.w.problem?.severity === 'warning',
            }"
            :data-depth="r.depth"
            data-testid="server-workload-row"
            @click="open(r)"
          >
            <td class="c-name">
              <div
                class="flex min-w-0 items-baseline"
                :style="{ paddingLeft: `${r.depth * 18}px` }"
              >
                <span v-if="r.depth" class="mr-1.5 text-text-subtle" aria-hidden="true">└</span>
                <button
                  type="button"
                  class="block max-w-full truncate text-left font-mono font-medium text-text max-lg:min-w-11 max-lg:leading-11"
                  @click.stop="open(r)"
                >
                  <HighlightText :text="r.w.name" :terms="terms" /><span
                    class="kd"
                    data-testid="kind-tag"
                    >{{ kindTag(r) }}</span
                  >
                </button>
              </div>
              <p
                v-if="r.w.problem"
                class="line-clamp-2 text-12"
                :class="
                  r.w.problem.severity === 'critical' ? 'text-critical-text' : 'text-warning-text'
                "
                :style="{ paddingLeft: `${r.depth * 18}px` }"
                data-testid="problem-reason"
              >
                {{ reason(r) }}
              </p>
            </td>
            <td class="c-health">
              <span
                v-if="r.w.problem?.severity === 'critical'"
                class="pill crit"
                data-testid="health-badge"
                >✕ {{ $t('kube.workloads.badge.failing') }}</span
              >
              <span v-else-if="r.w.problem" class="pill warn" data-testid="health-badge"
                >▲ {{ $t('kube.workloads.badge.degraded') }}</span
              >
              <span
                v-else
                class="dot bg-ok"
                role="img"
                :aria-label="$t('servers.fleetWorkloads.healthy')"
                :title="$t('servers.fleetWorkloads.healthy')"
                data-testid="health-dot"
              />
            </td>
            <td
              class="num c-ready"
              :data-label="$t('servers.fleetWorkloads.columns.instances')"
              data-testid="instances"
            >
              {{ instances(r) }}
            </td>
            <td
              class="num c-restarts"
              :class="r.w.restarts24h != null && r.w.restarts24h >= 3 && 'text-critical-text'"
              :data-label="$t('servers.fleetWorkloads.columns.restarts')"
              data-testid="restarts"
            >
              {{ Math.round(r.w.restarts24h ?? 0) }}
            </td>
            <td class="c-cpu" :data-label="$t('servers.fleetWorkloads.columns.cpu')">
              <ResourceBar
                :usage="r.w.cpuCores"
                :request="null"
                :limit="r.w.cpuLimitCores"
                unit="cores"
                reference="limit"
              />
            </td>
            <td class="c-mem" :data-label="$t('servers.fleetWorkloads.columns.memory')">
              <ResourceBar
                :usage="r.w.memoryBytes"
                :request="null"
                :limit="r.w.memoryLimitBytes"
                unit="bytes"
                reference="limit"
              />
            </td>
            <td class="c-trend">
              <SparkLine
                v-if="r.w.cpuSeries.length"
                size="row"
                :values="values(r.w.cpuSeries)"
                :color-token="r.w.problem?.severity === 'critical' ? '--critical' : '--info'"
              />
            </td>
            <td
              class="img c-img"
              :title="r.w.runs ?? ''"
              :data-label="$t('servers.fleetWorkloads.columns.runs')"
              data-testid="runs"
            >
              <span class="block truncate">{{ r.w.runs ?? '–' }}</span>
            </td>
            <td
              class="num c-changed text-text-subtle"
              :data-label="$t('servers.fleetWorkloads.columns.changed')"
            >
              {{ r.w.changedAt ? since(new Date(r.w.changedAt * 1000).toISOString()) : '–' }}
            </td>
          </tr>
        </template>
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
tr.w:hover td {
  background: color-mix(in srgb, var(--text) 2%, transparent);
}
tr.attn td:first-child {
  box-shadow: inset 3px 0 0 var(--critical);
}
tr.warn td:first-child {
  box-shadow: inset 3px 0 0 var(--warning);
}
.kd {
  margin-left: 6px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-subtle);
  font-family: var(--font-sans, inherit);
  font-size: var(--text-12);
  font-weight: 400;
}
.img {
  font-family: var(--font-mono, ui-monospace, monospace);
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
  color: var(--critical-text);
  background: color-mix(in srgb, var(--critical) 12%, transparent);
}
.pill.warn {
  color: var(--warning-text);
  background: color-mix(in srgb, var(--warning) 12%, transparent);
}
.pill.ok {
  color: var(--link);
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
.text-critical-text {
  color: var(--critical-text);
}
.text-warning-text {
  color: var(--warning-text);
}
/* Phones: each workload is a card, as on the Kubernetes page; the servers stay headings. */
@media (max-width: 767px) {
  .tbl {
    min-width: 0;
    table-layout: auto;
  }
  .tbl colgroup,
  .tbl thead {
    display: none;
  }
  .tbl,
  .tbl tbody,
  .tbl tr,
  .tbl td {
    display: block;
  }
  tr.w {
    position: relative;
    display: grid;
    grid-template-areas:
      'name name'
      'ready restarts'
      'cpu mem'
      'img changed';
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px 16px;
    padding: 4px 12px 12px;
    border-bottom: 1px solid var(--border);
  }
  .tbl tr.w td {
    min-width: 0;
    padding: 0;
    border: 0;
  }
  tr.w td[data-label]::before {
    display: block;
    margin-bottom: 2px;
    color: var(--text-subtle);
    content: attr(data-label);
    font-family: var(--font-sans, inherit);
    font-size: var(--text-11);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .c-name {
    grid-area: name;
    padding-right: 112px !important;
  }
  .c-health {
    position: absolute;
    top: 14px;
    right: 12px;
  }
  .c-ready {
    grid-area: ready;
  }
  .c-restarts {
    grid-area: restarts;
  }
  .c-cpu {
    grid-area: cpu;
  }
  .c-mem {
    grid-area: mem;
  }
  .c-img {
    grid-area: img;
  }
  .c-changed {
    grid-area: changed;
  }
  .c-trend {
    display: none !important;
  }
  .tbl .num {
    text-align: left;
  }
  tr.attn td:first-child,
  tr.warn td:first-child {
    box-shadow: none;
  }
  tr.attn {
    box-shadow: inset 3px 0 0 var(--critical);
  }
  tr.warn {
    box-shadow: inset 3px 0 0 var(--warning);
  }
}
</style>
