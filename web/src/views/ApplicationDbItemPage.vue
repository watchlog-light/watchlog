<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowLeft, Database } from '@lucide/vue';
import type { ApplicationDetail, ApplicationPanels } from '@watchlog/api-types';
import { computed, onMounted, provide, reactive, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api } from '@/api/client';
import ServicePanel from '@/components/panels/ServicePanel.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonChart from '@/components/ui/SkeletonChart.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import { ServiceLogo } from '@/components/ui/serviceLogos';
import { useLoader } from '@/composables/useLoader';
import { PAGE_RANGES, rangeOf } from '@/lib/panels';
import { offeredRanges } from '@/lib/ranges';
import { SERVICE_PAGE } from '@/lib/service-page';
import { useAuthStore } from '@/stores/auth';

// One database statement or table (1.2, ADR-245), each at its own address
// (/applications/:id/statements/:statement, /applications/:id/tables/:db/:table): a
// statement's history, its waits, who sends it, the tables it names, the missing-index hint
// and its alerts; a table's size and growth, dead rows, scans, indexes and alerts. With the
// service's time range, as a RabbitMQ queue's page (1.1.0).
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const id = computed(() => String(route.params.id));
const isTable = computed(() => route.name === 'application-table');
// 1.4: Redis's prefix, command and stream group pages (tab=prefix|command|group).
const isItem = computed(() => route.name === 'application-item');
const itemTab = computed(() => String(route.params.tab ?? ''));
const item = computed(() => String(route.params.item ?? ''));
const statement = computed(() => String(route.params.statement ?? ''));
const table = computed(
  () => `${String(route.params.db ?? '')}/${String(route.params.table ?? '')}`,
);
// Back to the tab the item belongs to: MongoDB's are Operations and Collections (1.4).
const back = computed(() => {
  if (isItem.value)
    return { prefix: 'memory', command: 'commands', group: 'streams' }[itemTab.value] ?? 'overview';
  if (app.value?.type === 'mongodb') return isTable.value ? 'collections' : 'operations';
  return isTable.value ? 'tables' : 'queries';
});
const ranges = computed(() => offeredRanges(PAGE_RANGES, auth.demoMaxRangeS));
const range = computed(() => {
  const r = rangeOf(route.query.range);
  return ranges.value.some((x) => x.seconds === r)
    ? r
    : ranges.value[ranges.value.length - 1]!.seconds;
});

const page = useLoader(() =>
  api<ApplicationDetail>(`/applications/${id.value}?range=${range.value}`),
);
const app = computed(() => page.data.value?.application);
const panels = useLoader(() =>
  api<ApplicationPanels>(
    isItem.value
      ? `/applications/${id.value}/panels?tab=${encodeURIComponent(itemTab.value)}&${encodeURIComponent(itemTab.value)}=${encodeURIComponent(item.value)}&range=${range.value}`
      : isTable.value
        ? `/applications/${id.value}/panels?tab=table&table=${encodeURIComponent(table.value)}&range=${range.value}`
        : `/applications/${id.value}/panels?tab=statement&statement=${encodeURIComponent(statement.value)}&range=${range.value}`,
  ),
);
const window = computed<[number, number]>(() => {
  const end = Math.floor(Date.now() / 1000);
  return [end - range.value, end];
});
const notFound = computed(
  () => page.error.value instanceof ApiError && page.error.value.status === 404,
);
// The heading: a statement's normalised text (from its facts), or the table's name.
const name = computed(() => {
  if (isItem.value) {
    if (itemTab.value === 'prefix') return `${item.value}*`;
    if (itemTab.value === 'command') return item.value.toUpperCase();
    return item.value.replace('\u0000', ' · ');
  }
  if (isTable.value)
    return app.value?.type === 'mongodb'
      ? table.value.replace('/', '.')
      : table.value.replace('/', ': ');
  const f = panels.data.value?.panels.find((p) => p.id === 'facts');
  const rows = f?.kind === 'facts' ? f.rows : [];
  const text = rows.find((r) => r.labelKey.endsWith('statement.text'))?.value;
  return typeof text === 'string' && text ? text : statement.value;
});

const servicePage = reactive({ appId: '', clusterId: '' });
provide(SERVICE_PAGE, servicePage);
watch(
  () => [id.value, app.value?.cluster.id] as const,
  ([a, c]) => {
    servicePage.appId = a;
    servicePage.clusterId = c ?? '';
  },
  { immediate: true },
);

onMounted(async () => {
  await page.load();
  if (page.data.value) await panels.load();
});
watch([range, statement, table, item], () => {
  void page.load();
  void panels.load();
});
function setRange(seconds: number) {
  void router.replace({
    query: { ...route.query, range: seconds === 3600 ? undefined : String(seconds) },
  });
}
</script>

<template>
  <div class="flex flex-col gap-5" data-testid="application-db-item">
    <RouterLink
      :to="{ name: 'application', params: { id }, query: { tab: back } }"
      class="inline-flex items-center gap-1.5 self-start text-13 text-text-muted hover:text-text max-lg:min-h-11"
      data-testid="db-item-back"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />{{
        app
          ? isItem || app.type === 'mongodb'
            ? $t('integrations.db.panels.backToTab', {
                name: app.name,
                tab: $t(`integrations.${app.type}.tabs.${back}`),
              })
            : $t(
                isTable
                  ? 'integrations.db.panels.backToTables'
                  : 'integrations.db.panels.backToQueries',
                { name: app.name },
              )
          : $t('nav.applications')
      }}
    </RouterLink>

    <EmptyState
      v-if="notFound"
      :icon="Database"
      :title="$t('integrations.page.notFound.title')"
      :description="$t('integrations.page.notFound.description')"
      :action-label="$t('nav.applications')"
      :action-to="{ name: 'applications' }"
    />
    <ErrorState
      v-else-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('integrations.page.error')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <SkeletonDetailHeader v-if="page.skeleton.value" :label="$t('common.loading')" />

    <template v-else-if="app">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex min-w-0 items-center gap-3.5">
          <span
            class="flex size-14 shrink-0 items-center justify-center rounded-[14px] border border-border bg-surface-1"
          >
            <ServiceLogo :type="app.type" class="size-8.5" />
          </span>
          <div class="flex min-w-0 flex-col gap-1.5">
            <h2
              class="line-clamp-3 font-mono text-18 font-semibold break-all text-text"
              :title="name"
              data-testid="db-item-name"
            >
              {{ name }}
            </h2>
            <span class="flex flex-wrap items-center gap-1.5 text-13 text-text-muted">
              {{
                $t(
                  isItem
                    ? `integrations.redis.panels.item.${itemTab}`
                    : app.type === 'mongodb'
                      ? isTable
                        ? 'integrations.mongodb.panels.item.collection'
                        : 'integrations.mongodb.panels.item.shape'
                      : isTable
                        ? 'integrations.db.panels.aTable'
                        : 'integrations.db.panels.aStatement',
                  { id: statement },
                )
              }}
              · <span class="font-mono">{{ app.name }}</span>
            </span>
          </div>
        </div>
        <div
          role="group"
          :aria-label="$t('integrations.page.range')"
          class="flex gap-0.5 rounded-control border border-border bg-surface-1 p-0.5"
        >
          <button
            v-for="r in ranges"
            :key="r.seconds"
            type="button"
            :aria-pressed="range === r.seconds"
            :class="[
              'h-8 rounded-[6px] border px-2.5 text-12 font-medium max-lg:min-h-11 max-lg:min-w-11',
              range === r.seconds
                ? 'border-border-strong bg-surface-3 text-text'
                : 'border-transparent text-text-muted hover:text-text',
            ]"
            data-testid="range"
            @click="setRange(r.seconds)"
          >
            {{ r.label }}
          </button>
        </div>
      </header>

      <ErrorState
        v-if="panels.error.value && !panels.data.value"
        inline
        :message="$t('integrations.panel.error')"
        :retrying="panels.loading.value"
        @retry="panels.load"
      />
      <div
        v-else-if="!panels.data.value"
        class="grid gap-3.5 md:grid-cols-2"
        role="status"
        :aria-label="$t('common.loading')"
      >
        <div
          v-for="i in 2"
          :key="i"
          class="relative h-60 rounded-card border border-border bg-surface-1 p-4"
        >
          <SkeletonChart />
        </div>
      </div>
      <div
        v-else
        class="grid gap-3.5 md:grid-cols-2"
        :aria-busy="panels.loading.value ? 'true' : undefined"
        data-testid="panels"
      >
        <ServicePanel
          v-for="p in panels.data.value.panels"
          :key="p.id"
          :panel="p"
          :window="window"
          :loading="panels.loading.value"
          :error="!!panels.error.value"
          :class="['min-w-0', p.span === 2 ? 'md:col-span-2' : '']"
          @retry="panels.load"
          @changed="panels.load"
        />
      </div>
    </template>
  </div>
</template>
