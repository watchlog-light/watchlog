<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowUpRight, Globe } from '@lucide/vue';
import type { AlertDetail, Egress, EgressRow } from '@watchlog/api-types';
import { formatBytes } from '@watchlog/cause-words';
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useLoader } from '@/composables/useLoader';
import { egressQueryOf, egressSourceOf } from '@/lib/alerts';
import { egressHistoryRange, egressPath, percent } from '@/lib/egress';
import { useAuthStore } from '@/stores/auth';
import { formatDateTime } from '@/lib/format';
import ExpectedActions from './ExpectedActions.vue';

// An egress alert's facts on its detail page (ADR-187; the "New external destination" screen):
// the destination as data, its first connection, the connections and bytes from the source,
// which other sources use it, "Mark expected" for the source or every source (ADR-186, the
// alert resolves at the next check), the Egress page filtered to the source and destination,
// and why "New" alerts are rare. The numbers come from the Egress route, as the page shows them.
const props = defineProps<{ alert: AlertDetail['alert']; now?: number }>();
const { t } = useI18n();
const auth = useAuthStore();

const kind = computed(() => (props.alert.cluster.kind === 'server' ? 'server' : 'kubernetes'));
const destination = computed(() => props.alert.labels.destination ?? '');
const port = computed(() => Number(props.alert.labels.port ?? 0));
const target = computed(() =>
  port.value ? `${destination.value}:${port.value}` : destination.value,
);
const source = computed(() => egressSourceOf(props.alert));
const sourceQuery = computed(() => egressQueryOf(props.alert));
const isNew = computed(() => props.alert.rule.key === 'egress.new_destination');

const same = (r: EgressRow) => r.destination === destination.value && r.port === port.value;
const page = useLoader(async () => {
  const now = props.now ?? Date.now();
  const q = { q: destination.value };
  // The demo answers at most 24 hours: there the card reads the last day.
  const history = egressHistoryRange(auth.demoMode);
  const [mine, all] = await Promise.all([
    api<Egress>(egressPath(props.alert.cluster.id, { ...sourceQuery.value, ...q }, history, now)),
    api<Egress>(egressPath(props.alert.cluster.id, q, history, now)),
  ]);
  return {
    row: mine.rows.find(same) ?? null,
    all: all.rows.find(same) ?? null,
    learning: mine.learning,
  };
});
onMounted(page.load);

const others = computed(() => Math.max(0, (page.data.value?.all?.sources.length ?? 1) - 1));
const unit = (n: number) => t(`egress.unit.${kind.value}`, n);
const learningDays = computed(() => {
  const l = page.data.value?.learning;
  return l ? Math.round((Date.parse(l.until) - Date.parse(l.since)) / 86_400_000) : 7;
});
const link = computed(() => ({
  name: 'egress',
  query: { cluster: props.alert.cluster.id, ...sourceQuery.value, q: destination.value },
}));
const bytes = (r: EgressRow) =>
  r.sent === null || r.received === null
    ? '–'
    : `${formatBytes(r.sent)} / ${formatBytes(r.received)}`;
</script>

<template>
  <section
    class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-5 max-md:p-4"
    aria-labelledby="egress-alert-title"
    data-testid="egress-alert"
  >
    <header class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
      <Globe class="size-4.5 shrink-0 text-info-text" aria-hidden="true" />
      <h3 id="egress-alert-title" class="text-14 font-semibold text-text">
        {{ $t('egress.alert.title') }}
      </h3>
      <code
        class="min-w-0 rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-13 break-all text-text"
        data-testid="egress-alert-destination"
        >{{ target }}</code
      >
    </header>

    <div v-if="page.skeleton.value" class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Skeleton v-for="i in 4" :key="i" class="h-12" />
    </div>
    <p
      v-else-if="page.error.value"
      class="text-13 text-text-muted"
      data-testid="egress-alert-error"
    >
      {{ $t('egress.alert.loadError') }}
      <button type="button" class="text-accent hover:underline max-lg:min-h-11" @click="page.load">
        {{ $t('common.retry') }}
      </button>
    </p>
    <dl
      v-else
      class="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4"
      data-testid="egress-alert-facts"
    >
      <div>
        <dt class="text-12 text-text-muted">{{ $t('egress.alert.firstConnection') }}</dt>
        <dd class="text-14 text-text tabular">{{ formatDateTime(alert.startedAt) }}</dd>
      </div>
      <div>
        <dt class="text-12 text-text-muted">{{ $t('egress.alert.connections') }}</dt>
        <dd class="text-14 text-text tabular" data-testid="egress-alert-connections">
          {{ page.data.value?.row?.connections?.toLocaleString('en') ?? '–' }}
          <span v-if="page.data.value?.row?.failedRatio" class="text-12 text-text-muted"
            >·
            {{ $t('egress.alert.failed', { pct: percent(page.data.value.row.failedRatio) }) }}</span
          >
        </dd>
      </div>
      <div>
        <dt class="text-12 text-text-muted">{{ $t('egress.alert.bytes') }}</dt>
        <dd class="text-14 text-text tabular" data-testid="egress-alert-bytes">
          {{ page.data.value?.row ? bytes(page.data.value.row) : '–' }}
        </dd>
      </div>
      <div>
        <dt class="text-12 text-text-muted">
          {{ $t('egress.alert.others', { units: unit(2) }) }}
        </dt>
        <dd class="text-14 text-text tabular" data-testid="egress-alert-others">
          {{ others ? others.toLocaleString('en') : $t('egress.alert.none') }}
        </dd>
      </div>
    </dl>

    <p
      v-if="page.data.value?.row?.expected"
      class="text-13 text-text"
      data-testid="egress-alert-expected"
    >
      {{
        $t(alert.state === 'resolved' ? 'egress.alert.expectedResolved' : 'egress.alert.expected', {
          pattern: page.data.value.row.expected.pattern,
        })
      }}
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <ExpectedActions
        v-if="page.data.value?.row && (alert.state !== 'resolved' || page.data.value.row.expected)"
        :row="page.data.value.row"
        :cluster-id="alert.cluster.id"
        :kind="kind"
        :source="source"
        @changed="page.load"
      />
      <RouterLink
        :to="link"
        class="inline-flex items-center gap-1 text-13 text-text-muted hover:text-text hover:underline max-lg:min-h-11"
        data-testid="egress-alert-open"
      >
        {{ $t('egress.alert.open') }}
        <ArrowUpRight class="size-3.5" aria-hidden="true" />
      </RouterLink>
    </div>

    <p v-if="isNew" class="text-12 text-text-subtle" data-testid="egress-alert-quiet">
      {{
        $t('egress.alert.quiet', {
          days: learningDays,
          cluster: alert.cluster.name,
          unit: unit(1),
        })
      }}
    </p>
    <p v-else class="text-12 text-text-subtle">{{ $t('egress.alert.stillAlerts') }}</p>
  </section>
</template>
