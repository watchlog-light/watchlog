<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronRight, Database } from '@lucide/vue';
import type { Application, DiscoveredService } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api/client';
import MonitorDrawer from '@/components/applications/MonitorDrawer.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { KIND_LOGO } from '@/components/ui/kindLogos';
import { ServiceLogo } from '@/components/ui/serviceLogos';
import { useLoader } from '@/composables/useLoader';
import { useNarrow } from '@/composables/useNarrow';
import {
  discoveredHint,
  familyCounts,
  familyOf,
  NEEDS_USER,
  reasonText,
  serviceName,
  sortApplications,
  whereText,
  type Family,
  type SortKey,
} from '@/lib/applications';
import { formatDateTime } from '@/lib/format';
import { useApplicationsStore } from '@/stores/applications';
import { useAuthStore } from '@/stores/auth';

// Applications (SPEC §4.12, ADR-135): services found but not monitored yet, then every
// monitored service, problems first, filtered by type (?type=) and sorted (?sort=).
// Phones get one card per service instead of the table's columns.
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const store = useApplicationsStore();
const narrow = useNarrow();

const page = useLoader(async () => {
  const [, discovered] = await Promise.all([
    store.load(),
    api<{ discovered: DiscoveredService[] }>('/applications/discovered'),
  ]);
  return { discovered: discovered.discovered };
});
onMounted(page.load);

const discovered = computed(() => page.data.value?.discovered ?? []);
const family = computed<Family | 'all'>(() => {
  const v = route.query.type;
  return typeof v === 'string' && v ? (v as Family) : 'all';
});
const sort = computed<SortKey>(() =>
  route.query.sort === 'name' || route.query.sort === 'cluster' ? route.query.sort : 'problems',
);
const filters = computed(() => [
  { family: 'all' as const, n: store.list.length },
  ...familyCounts(store.list),
]);
const rows = computed(() =>
  sortApplications(
    store.list.filter((a) => family.value === 'all' || familyOf(a.type) === family.value),
    sort.value,
  ),
);
const sortOptions = computed(() =>
  (['problems', 'name', 'cluster'] as const).map((v) => ({
    value: v,
    label: t(`applications.sort.${v}`),
  })),
);
function setQuery(patch: Record<string, string | undefined>) {
  void router.replace({ query: { ...route.query, ...patch } });
}

const reason = (a: Application) => reasonText(a, (iso) => formatDateTime(iso));
const HEALTH_STYLE: Record<Application['health'], string> = {
  ok: 'bg-ok/15 text-ok',
  warning: 'bg-warning/15 text-warning',
  critical: 'bg-critical/15 text-critical',
  unknown: 'bg-surface-3 text-text-muted',
};
const REASON_STYLE: Record<Application['health'], string> = {
  ok: 'text-text-muted',
  warning: 'text-warning',
  critical: 'text-critical',
  unknown: 'text-text-muted',
};

// Monitor: the drawer shows what was detected and starts it (slice 4 adds the access step).
const monitoring = ref<DiscoveredService | null>(null);
const drawerOpen = computed({
  get: () => monitoring.value !== null,
  set: (v: boolean) => {
    if (!v) monitoring.value = null;
  },
});
async function started() {
  monitoring.value = null;
  await page.load();
}
</script>

<template>
  <div class="flex flex-col gap-5" data-testid="applications">
    <p class="text-14 text-text-muted">{{ $t('applications.subtitle') }}</p>

    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('applications.error')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <SkeletonTable
      v-if="page.skeleton.value"
      :columns="5"
      :rows="4"
      :label="$t('common.loading')"
    />

    <template v-else-if="page.loaded.value">
      <!-- Found, not monitored yet (ADR-132). -->
      <section
        v-if="discovered.length > 0"
        :aria-label="
          $t('applications.discovered.title', { n: discovered.length }, discovered.length)
        "
        class="flex flex-col gap-3 rounded-card border border-ok/30 bg-ok/5 px-4 py-4 sm:px-5"
        data-testid="discovered"
      >
        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span class="size-2 shrink-0 rounded-full bg-ok" aria-hidden="true" />
          <span class="text-14 font-semibold text-text">{{
            $t('applications.discovered.title', { n: discovered.length }, discovered.length)
          }}</span>
          <span class="text-13 text-text-muted">{{ $t('applications.discovered.from') }}</span>
        </div>
        <ul class="flex flex-col gap-2">
          <li
            v-for="d in discovered"
            :key="d.key"
            class="flex flex-wrap items-center gap-3 rounded-[10px] border border-border bg-surface-1 px-3 py-2.5"
            data-testid="discovered-row"
          >
            <ServiceLogo :type="d.type" class="size-7.5 shrink-0" />
            <div class="flex min-w-0 flex-[1_1_16rem] flex-col gap-0.5">
              <span class="text-14 font-medium text-text">
                {{ serviceName(d.type) }}{{ d.version ? ` ${d.version}` : '' }}
                <span class="text-text-muted">·</span>
                <span class="font-mono">{{ d.name }}</span>
              </span>
              <span class="flex min-w-0 items-center gap-1.5 text-12 text-text-muted">
                <component
                  :is="KIND_LOGO[d.cluster.kind]"
                  class="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span class="truncate">
                  {{ d.cluster.name
                  }}{{ d.host && d.cluster.kind === 'docker' ? ` · ${d.host}` : '' }} ·
                  {{ $t(discoveredHint(d).key, discoveredHint(d).values) }}
                </span>
              </span>
            </div>
            <span :class="['text-12', NEEDS_USER.has(d.type) ? 'text-warning' : 'text-ok']">
              {{
                NEEDS_USER.has(d.type)
                  ? $t('applications.discovered.needsUser')
                  : $t('applications.discovered.ready')
              }}
            </span>
            <BaseButton
              v-if="auth.canManage"
              :aria-label="$t('applications.discovered.monitorName', { name: d.name })"
              data-testid="monitor"
              @click="monitoring = d"
            >
              {{ $t('applications.discovered.monitor') }}
            </BaseButton>
          </li>
        </ul>
      </section>

      <EmptyState
        v-if="store.list.length === 0 && discovered.length === 0"
        :icon="Database"
        :title="$t('applications.empty.title')"
        :description="$t('applications.empty.description')"
      />

      <template v-else-if="store.list.length > 0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div
            role="group"
            :aria-label="$t('applications.filters.label')"
            class="flex flex-wrap gap-1.5"
          >
            <button
              v-for="f in filters"
              :key="f.family"
              type="button"
              :aria-pressed="family === f.family"
              :class="[
                'inline-flex h-8.5 items-center gap-1.5 rounded-full border px-3 text-13 font-medium max-lg:min-h-11',
                family === f.family
                  ? 'border-border-strong bg-surface-3 text-text'
                  : 'border-border text-text-muted hover:bg-surface-2',
              ]"
              data-testid="family-filter"
              @click="setQuery({ type: f.family === 'all' ? undefined : f.family })"
            >
              {{ $t(`applications.filters.${f.family}`) }}
              <span class="text-text-muted">{{ f.n }}</span>
            </button>
          </div>
          <div class="w-44">
            <ComboBox
              :model-value="sort"
              :options="sortOptions"
              :label="$t('applications.sort.label')"
              testid="applications-sort"
              @update:model-value="
                (v) => setQuery({ sort: v === 'problems' ? undefined : (v ?? undefined) })
              "
            />
          </div>
        </div>

        <section class="overflow-hidden rounded-card border border-border bg-surface-1">
          <div
            v-if="!narrow"
            class="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_minmax(0,2.6fr)_minmax(0,1fr)_1.5rem] gap-4 border-b border-border px-4 py-2.5 text-11 font-medium tracking-wider text-text-muted uppercase"
          >
            <span>{{ $t('applications.columns.service') }}</span>
            <span>{{ $t('applications.columns.where') }}</span>
            <span>{{ $t('applications.columns.health') }}</span>
            <span>{{ $t('applications.columns.metrics') }}</span>
            <span />
          </div>
          <ul data-testid="application-list">
            <li
              v-for="a in rows"
              :key="a.id"
              :class="[
                'border-t border-border first:border-t-0',
                a.health === 'critical' ? 'bg-critical/5' : '',
              ]"
              data-testid="application-row"
            >
              <div
                :class="
                  narrow
                    ? 'flex flex-col gap-2.5 px-4 py-3.5'
                    : 'grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_minmax(0,2.6fr)_minmax(0,1fr)_1.5rem] items-center gap-4 px-4 py-3.5'
                "
              >
                <span class="flex min-w-0 items-center gap-3">
                  <ServiceLogo :type="a.type" class="size-8 shrink-0" />
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="truncate font-mono text-14 font-medium text-text">{{
                      a.name
                    }}</span>
                    <span class="truncate text-12 text-text-muted">
                      {{ serviceName(a.type) }}{{ a.version ? ` ${a.version}` : '' }}
                    </span>
                  </span>
                </span>
                <span class="flex min-w-0 items-center gap-1.5 text-13 text-text-muted">
                  <component
                    :is="KIND_LOGO[a.cluster.kind]"
                    class="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span class="truncate">{{ whereText(a) }}</span>
                </span>
                <span class="flex min-w-0 flex-col items-start gap-1">
                  <span
                    :class="[
                      'inline-flex h-5.5 items-center rounded-full px-2.5 text-12 font-semibold',
                      HEALTH_STYLE[a.health],
                    ]"
                    data-testid="health"
                    >{{ $t(`applications.health.${a.health}`) }}</span
                  >
                  <span
                    :class="['text-13 leading-snug', REASON_STYLE[a.health]]"
                    data-testid="reason"
                    >{{ $t(reason(a).key, reason(a).values) }}</span
                  >
                </span>
                <span class="text-13 text-text-muted">
                  <template v-if="a.members.total > 0">{{
                    $t('applications.members', { up: a.members.up, total: a.members.total })
                  }}</template>
                </span>
                <ChevronRight v-if="!narrow" class="size-4 text-text-subtle" aria-hidden="true" />
              </div>
            </li>
          </ul>
        </section>
      </template>
    </template>

    <MonitorDrawer
      v-if="monitoring"
      v-model:open="drawerOpen"
      :service="monitoring"
      @started="started"
    />
  </div>
</template>
