<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// The sources of a cluster's own metrics (1.0.0, ADR-236): how each arrives, what it belongs
// to, its series, when it last reported, and what was dropped of it and why.
import type { OwnMetricsSummary, OwnSource } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ownMetricsApi } from '@/api/own-metrics';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import { agoShort } from '@/lib/format';
import { ownerLink, ownerText, wayOf } from '@/lib/own-metrics';
import { useAuthStore } from '@/stores/auth';

const props = defineProps<{ cluster: string; summary: OwnMetricsSummary }>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const auth = useAuthStore();

const total = computed(() => props.summary.sources.reduce((n, s) => n + s.series, 0));

/** Where a source's series belong: its own owner, or the owners its series name. */
function owners(s: OwnSource) {
  const list = s.owner.kind ? [s.owner] : s.owners;
  return list.map((o) => ({ text: ownerText(o)!, to: ownerLink(o, props.cluster) }));
}

/** What was dropped of a source, one line per reason. */
function problems(s: OwnSource): string[] {
  const { limits } = props.summary;
  const out: string[] = [];
  if (s.refused) out.push(t('ownMetrics.sources.dropped.sources', { max: limits.sources ?? 0 }));
  if (s.error) out.push(t('ownMetrics.sources.failing', { error: s.error }));
  const d = s.dropped;
  if (d.sourceCap)
    out.push(
      t(
        'ownMetrics.sources.dropped.sourceCap',
        { n: d.sourceCap, max: limits.seriesPerSource },
        d.sourceCap,
      ),
    );
  if (d.orgCap)
    out.push(
      t(
        'ownMetrics.sources.dropped.orgCap',
        { n: d.orgCap, max: limits.series.toLocaleString('en-US') },
        d.orgCap,
      ),
    );
  for (const c of d.cardinality)
    out.push(t('ownMetrics.sources.dropped.cardinality', { metric: c.metric, label: c.label }));
  if (d.reserved) out.push(t('ownMetrics.sources.dropped.reserved', { n: d.reserved }, d.reserved));
  if (d.invalid) out.push(t('ownMetrics.sources.dropped.invalid', { n: d.invalid }, d.invalid));
  return out;
}

const removing = ref<OwnSource | null>(null);
const open = computed({
  get: () => removing.value !== null,
  set: (v) => {
    if (!v) removing.value = null;
  },
});
async function remove() {
  await ownMetricsApi.removeSource(props.cluster, removing.value!.id);
  emit('changed');
}
</script>

<template>
  <section
    class="overflow-hidden rounded-card border border-border bg-surface-1"
    data-testid="own-sources"
  >
    <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
      <h2 class="text-14 font-semibold text-text">{{ $t('ownMetrics.sources.title') }}</h2>
      <span class="text-13 text-text-muted">
        {{
          $t(
            'ownMetrics.sources.count',
            { n: summary.sources.length, series: total.toLocaleString('en-US') },
            summary.sources.length,
          )
        }}
      </span>
    </div>
    <p
      v-if="summary.sources.length === 0"
      class="border-t border-border px-5 py-5 text-14 text-text-muted"
    >
      {{ $t('ownMetrics.sources.none') }}
    </p>
    <div v-else class="overflow-x-auto">
      <table class="w-full min-w-[640px] border-collapse text-left text-14">
        <thead>
          <tr class="border-t border-border text-12 text-text-subtle">
            <th class="px-5 py-2 font-medium">{{ $t('ownMetrics.sources.col.source') }}</th>
            <th class="px-3 py-2 font-medium">{{ $t('ownMetrics.sources.col.how') }}</th>
            <th class="px-3 py-2 font-medium">{{ $t('ownMetrics.sources.col.owner') }}</th>
            <th class="px-3 py-2 text-right font-medium">
              {{ $t('ownMetrics.sources.col.series') }}
            </th>
            <th class="px-3 py-2 font-medium">{{ $t('ownMetrics.sources.col.state') }}</th>
            <th class="px-5 py-2">
              <span class="sr-only">{{ $t('ownMetrics.sources.remove') }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="s in summary.sources"
            :key="s.id"
            class="border-t border-border align-top"
            data-testid="own-source"
          >
            <td class="px-5 py-3 font-mono text-13 break-all text-text">{{ s.label }}</td>
            <td class="px-3 py-3 whitespace-nowrap text-text-muted">
              {{ $t(`ownMetrics.sources.how.${wayOf(s.kind)}`) }}
            </td>
            <td class="px-3 py-3 text-text">
              <template v-if="owners(s).length">
                <template v-for="(o, i) in owners(s)" :key="o.text">
                  {{ i ? ', ' : ''
                  }}<RouterLink v-if="o.to" :to="o.to" class="text-link hover:underline">{{
                    o.text
                  }}</RouterLink
                  ><template v-else>{{ o.text }}</template>
                </template>
              </template>
              <span v-else class="text-text-muted">{{ $t('ownMetrics.from.untied') }}</span>
            </td>
            <td class="px-3 py-3 text-right tabular-nums text-text">
              {{ s.series.toLocaleString('en-US') }}
            </td>
            <td class="px-3 py-3">
              <span
                :class="s.error || s.refused ? 'text-critical-text' : 'text-text'"
                data-testid="own-source-state"
              >
                <template v-if="s.lastReportedAt === null">{{
                  $t('ownMetrics.sources.waiting')
                }}</template>
                <template v-else-if="s.error || s.refused">{{
                  $t('ownMetrics.sources.notOk')
                }}</template>
                <template v-else>{{
                  $t('ownMetrics.sources.ok', { ago: agoShort(s.lastReportedAt / 1000) })
                }}</template>
              </span>
              <ul v-if="problems(s).length" class="mt-1 text-13 text-text-muted">
                <li v-for="p in problems(s)" :key="p" data-testid="own-source-dropped">{{ p }}</li>
              </ul>
            </td>
            <td class="px-5 py-3 text-right">
              <button
                v-if="s.removable && auth.canManage"
                type="button"
                class="text-13 text-link hover:underline max-lg:min-h-11"
                data-testid="own-source-remove"
                @click="removing = s"
              >
                {{ $t('ownMetrics.sources.remove') }}
              </button>
              <span
                v-else-if="s.by === 'watchlog' || s.by === 'prometheus'"
                class="text-12 text-text-subtle"
                >{{ $t('ownMetrics.sources.byAnnotation') }}</span
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <ConfirmDialog
      v-model:open="open"
      :title="$t('ownMetrics.sources.removeTitle')"
      :subject="removing?.label"
      :lines="[$t('ownMetrics.sources.removeBody')]"
      :confirm-label="$t('ownMetrics.sources.removeConfirm')"
      :action="remove"
      testid="own-source-confirm"
    />
  </section>
</template>
