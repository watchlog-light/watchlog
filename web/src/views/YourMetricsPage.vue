<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Your metrics (1.0.0, ADR-236): the numbers a user's own apps and exporters report. A header
// with what is used of the plan's series and "Add a source"; then the tabs. Without a source
// and without a metric: the three ways in.
import { Plus } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { ownMetricsApi } from '@/api/own-metrics';
import AddToDashboard from '@/components/own-metrics/AddToDashboard.vue';
import AlertsTab from '@/components/own-metrics/AlertsTab.vue';
import DashboardsTab from '@/components/own-metrics/DashboardsTab.vue';
import MetricDetail from '@/components/own-metrics/MetricDetail.vue';
import MetricList from '@/components/own-metrics/MetricList.vue';
import OwnEmpty from '@/components/own-metrics/OwnEmpty.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useLoader } from '@/composables/useLoader';
import { useNarrow } from '@/composables/useNarrow';
import { usePolling } from '@/composables/usePolling';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { useToastStore } from '@/stores/toast';

const TABS = ['dashboards', 'metrics', 'alerts'] as const;
type Tab = (typeof TABS)[number];

const route = useRoute();
const router = useRouter();
const clusters = useClustersStore();
const auth = useAuthStore();
const narrow = useNarrow('(max-width: 1023px)');

const showAll = ref(route.query.all === '1');
const page = useLoader(async () => {
  await clusters.ensure();
  const c = clusters.selected;
  if (!c) return null;
  const [summary, list] = await Promise.all([
    ownMetricsApi.summary(c.id),
    ownMetricsApi.metrics(c.id, { all: showAll.value, spark: true }),
  ]);
  return { cluster: c, summary, list };
});
onMounted(() => void page.load());
watch(
  () => clusters.selected?.id,
  () => void page.load(),
);
watch(showAll, (v) => {
  void router.replace({ query: { ...route.query, all: v ? '1' : undefined } });
  void page.load();
});
const poll = usePolling(() => page.load(), 30_000);
poll.start();

const tab = computed<Tab>(() => {
  const q = route.query.tab;
  return (TABS as readonly string[]).includes(q as string) ? (q as Tab) : TABS[0];
});
const setTab = (t: Tab) =>
  void router.replace({ query: { ...route.query, tab: t === TABS[0] ? undefined : t } });

const data = computed(() => page.data.value);
const metrics = computed(() => data.value?.list.metrics ?? []);
const nothing = computed(
  () =>
    !!data.value &&
    data.value.summary.sources.length === 0 &&
    metrics.value.length === 0 &&
    data.value.list.hidden === 0,
);
const usage = computed(() => data.value?.summary.usage.series ?? 0);
const allowed = computed(() => data.value?.summary.limits.series ?? 0);
const full = computed(() => allowed.value > 0 && usage.value >= allowed.value);

// The selected metric: the address's, else the first of the list on a wide screen.
const selected = computed<string | null>(() => {
  const q = typeof route.query.metric === 'string' ? route.query.metric : null;
  if (q && metrics.value.some((m) => m.id === q)) return q;
  return narrow.value ? null : (metrics.value[0]?.id ?? null);
});
const select = (id: string | null) =>
  void router.replace({ query: { ...route.query, metric: id ?? undefined } });

// "Alert on it": the Alerts tab, with the metric already chosen.
const alertOn = (id: string) =>
  void router.replace({ query: { ...route.query, tab: 'alerts', alert: id } });

// "Add to a dashboard" from the selected metric.
const { t } = useI18n();
const toast = useToastStore();
const adding = ref(false);
// "Put it on a dashboard" from Add a source's first value (1.0.3): the dialog opens here.
watch(
  () => [route.query.add, selected.value] as const,
  ([add, id]) => {
    if (add !== 'dashboard' || !id) return;
    adding.value = true;
    void router.replace({ query: { ...route.query, add: undefined } });
  },
  { immediate: true },
);
/** Bumped when something the detail lists changed elsewhere (a dashboard it was added to). */
const detailKey = ref(0);
const selectedMetric = computed(() => metrics.value.find((m) => m.id === selected.value) ?? null);
function added(d: { id: string; name: string }) {
  toast.show(t('ownMetrics.dashboards.added', { name: d.name }), 'info', {
    label: t('ownMetrics.dashboards.open'),
    run: () =>
      void router.push({
        name: 'your-metrics',
        query: { cluster: data.value?.cluster.id, dashboard: d.id },
      }),
  });
  detailKey.value++;
}
</script>

<template>
  <div class="flex flex-col gap-5" data-testid="your-metrics">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <p class="max-w-2xl text-14 leading-relaxed text-text-muted">
        {{ $t('ownMetrics.intro') }}
      </p>
      <div v-if="data" class="flex flex-wrap items-center gap-3">
        <span
          :class="['text-13 tabular-nums', full ? 'text-warning-text' : 'text-text-muted']"
          data-testid="own-usage"
        >
          {{
            $t('ownMetrics.usage', {
              used: usage.toLocaleString('en-US'),
              max: allowed.toLocaleString('en-US'),
            })
          }}
        </span>
        <RouterLink
          v-if="auth.canManage || auth.demoMode"
          :to="{ name: 'your-metrics-add', query: { cluster: data.cluster.id } }"
          class="inline-flex h-9 items-center gap-1.5 rounded-control bg-primary px-3.5 text-14 font-semibold text-on-primary transition-colors hover:bg-primary-hover max-lg:h-11"
          data-testid="own-add"
        >
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('ownMetrics.addSource') }}
        </RouterLink>
      </div>
    </header>

    <p
      v-if="full"
      class="rounded-card border border-warning/40 bg-warning/10 px-4 py-3 text-14 text-text"
      role="status"
      data-testid="own-full"
    >
      {{ $t('ownMetrics.full', { max: allowed.toLocaleString('en-US') }) }}
      <RouterLink
        :to="{ name: 'your-metrics-add', query: { cluster: data!.cluster.id } }"
        class="text-link hover:underline"
        >{{ $t('ownMetrics.fullLink') }}</RouterLink
      >
    </p>

    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('ownMetrics.error')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <SkeletonTable v-else-if="!page.loaded.value" :label="$t('common.loading')" />
    <OwnEmpty v-else-if="nothing && data" :cluster="data.cluster.id" />
    <template v-else-if="data">
      <nav
        v-if="TABS.length > 1"
        role="tablist"
        class="flex gap-1 overflow-x-auto border-b border-border"
        :aria-label="$t('nav.yourMetrics')"
      >
        <button
          v-for="name in TABS"
          :key="name"
          type="button"
          role="tab"
          :aria-selected="tab === name"
          :class="[
            '-mb-px border-b-2 px-3 py-2 text-13 whitespace-nowrap transition-colors max-lg:min-h-11',
            tab === name
              ? 'border-primary text-text'
              : 'border-transparent text-text-muted hover:text-text',
          ]"
          :data-testid="`own-tab-${name}`"
          @click="setTab(name)"
        >
          {{ $t(`ownMetrics.tabs.${name}`) }}
        </button>
      </nav>

      <DashboardsTab
        v-if="tab === 'dashboards'"
        :cluster="{ id: data.cluster.id, name: data.cluster.name }"
        :metrics="metrics"
      />
      <div v-else-if="tab === 'metrics'" class="flex flex-wrap items-start gap-4">
        <MetricList
          v-if="!narrow || !selected"
          v-model:show-all="showAll"
          class="min-w-0 flex-[1_1_26rem]"
          :metrics="metrics"
          :hidden="data.list.hidden"
          :selected="selected"
          :initial-query="typeof route.query.q === 'string' ? route.query.q : ''"
          @select="select"
        />
        <div v-if="selected" class="min-w-0 flex-[1.5_1_32rem]">
          <button
            v-if="narrow"
            type="button"
            class="mb-3 inline-flex min-h-11 items-center text-14 text-link hover:underline"
            data-testid="own-back"
            @click="select(null)"
          >
            ← {{ $t('ownMetrics.tabs.metrics') }}
          </button>
          <MetricDetail
            :key="detailKey"
            :cluster="data.cluster.id"
            :metric-id="selected"
            @changed="page.load"
            @alert="alertOn"
          >
            <template #actions>
              <BaseButton data-testid="own-add-to-dashboard" @click="adding = true">
                {{ $t('ownMetrics.detail.addToDashboard') }}
              </BaseButton>
            </template>
          </MetricDetail>
          <AddToDashboard
            v-if="selectedMetric"
            v-model:open="adding"
            :metric="selectedMetric"
            :cluster="{ id: data.cluster.id, name: data.cluster.name }"
            @added="added"
          />
        </div>
      </div>
      <AlertsTab
        v-if="tab === 'alerts'"
        :cluster="{ id: data.cluster.id, name: data.cluster.name }"
        :metrics="metrics"
        :preset="typeof route.query.alert === 'string' ? route.query.alert : null"
      />
    </template>
  </div>
</template>
