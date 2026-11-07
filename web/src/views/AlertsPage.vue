<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Bell, BellOff, History } from '@lucide/vue';
import type {
  Alert,
  AlertChannelList,
  AlertList,
  AlertRule,
  AlertRuleList,
  ClusterList,
  SilenceList,
} from '@watchlog/api-types';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api/client';
import AlertTable from '@/components/alerts/AlertTable.vue';
import FiringView from '@/components/alerts/FiringView.vue';
import NewSilenceForm from '@/components/alerts/NewSilenceForm.vue';
import RuleDrawer from '@/components/alerts/RuleDrawer.vue';
import RulesView from '@/components/alerts/RulesView.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useLoader } from '@/composables/useLoader';
import { formatDateTime } from '@/lib/format';
import { useAuthStore } from '@/stores/auth';

// Alerts (SPEC §4.7, alerts redesign): what fires now, the history, silences and the
// rules, one page with four views (?view=) so links can point at each.
const VIEWS = ['firing', 'history', 'silences', 'rules'] as const;
type View = (typeof VIEWS)[number];
const REFRESH_MS = 30_000;
const route = useRoute();
const router = useRouter();
const canManage = useAuthStore().canManage;

const view = computed<View>(() =>
  VIEWS.includes(route.query.view as View) ? (route.query.view as View) : 'firing',
);
const ruleFilter = computed(() =>
  typeof route.query.rule === 'string' ? route.query.rule : undefined,
);

const firing = useLoader(async () => {
  const q = ruleFilter.value ? `?ruleId=${encodeURIComponent(ruleFilter.value)}` : '';
  const [list, cl, sil] = await Promise.all([
    api<AlertList>(`/alerts${q}`),
    api<ClusterList>('/clusters'),
    api<SilenceList>('/silences'),
  ]);
  silenceCount.value = sil.silences.length;
  return { list, clusters: cl.clusters };
});
const silenceCount = ref<number | null>(null);

const historyItems = ref<Alert[]>([]);
const nextCursor = ref<string | null>(null);
const history = useLoader(async () => {
  const res = await api<AlertList>('/alerts?view=history');
  historyItems.value = res.alerts;
  nextCursor.value = res.nextCursor;
  return res;
});
const loadingMore = ref(false);
async function loadMore() {
  if (!nextCursor.value) return;
  loadingMore.value = true;
  try {
    const res = await api<AlertList>(
      `/alerts?view=history&cursor=${encodeURIComponent(nextCursor.value)}`,
    );
    historyItems.value = [...historyItems.value, ...res.alerts];
    nextCursor.value = res.nextCursor;
  } finally {
    loadingMore.value = false;
  }
}

const silences = useLoader(async () => {
  const [s, cl] = await Promise.all([api<SilenceList>('/silences'), api<ClusterList>('/clusters')]);
  silenceCount.value = s.silences.length;
  return { silences: s.silences, clusters: cl.clusters };
});
const rules = useLoader(async () => {
  const [r, c, cl] = await Promise.all([
    api<AlertRuleList>('/alert-rules'),
    api<AlertChannelList>('/alert-channels'),
    api<ClusterList>('/clusters'),
  ]);
  return { rules: r.rules, channels: c.channels, clusters: cl.clusters };
});
const editing = ref<AlertRule | null>(null);
const drawerOpen = ref(false);
function openRule(rule: AlertRule | null) {
  if (!canManage) return;
  editing.value = rule;
  drawerOpen.value = true;
}

const loaders = { firing, history, silences, rules } as const;
const current = computed(() => loaders[view.value]);

const newSilence = computed(() => route.query.new === 'silence');
const ending = ref<string | null>(null);
async function endSilence(id: string) {
  ending.value = id;
  try {
    await api(`/silences/${id}`, { method: 'DELETE' });
    await silences.load();
  } finally {
    ending.value = null;
  }
}
function silenceCreated() {
  void router.replace({ query: { view: 'silences' } });
  void silences.load();
}

function setView(v: View) {
  void router.replace({
    query: { ...route.query, view: v === 'firing' ? undefined : v, new: undefined },
  });
}

let timer: ReturnType<typeof setInterval> | undefined;
watch(view, (v) => void loaders[v].load());
watch(ruleFilter, () => void firing.load());
onMounted(() => {
  void current.value.load();
  // The Firing and Silences tab counts show on every view, as in the design.
  if (view.value !== 'firing') void firing.load();
  timer = setInterval(() => {
    if (view.value === 'firing') void firing.load();
  }, REFRESH_MS);
});
onBeforeUnmount(() => clearInterval(timer));

const counts = computed(() => firing.data.value?.list.counts);
const tabCount = (v: View) =>
  v === 'firing' ? counts.value?.firing : v === 'silences' ? silenceCount.value : null;
</script>

<template>
  <div class="flex flex-col gap-5">
    <div class="flex flex-wrap items-end gap-3 border-b border-border">
      <nav role="tablist" class="-mb-px flex gap-1 overflow-x-auto" :aria-label="$t('nav.alerts')">
        <button
          v-for="v in VIEWS"
          :key="v"
          type="button"
          role="tab"
          :aria-selected="view === v"
          :class="[
            'flex items-center gap-1.5 border-b-2 px-3 py-2 text-13 whitespace-nowrap transition-colors max-lg:min-h-11',
            view === v
              ? 'border-primary text-text'
              : 'border-transparent text-text-muted hover:text-text',
          ]"
          :data-testid="`tab-${v}`"
          @click="setView(v)"
        >
          {{ $t(`alerts.tabs.${v}`) }}
          <span v-if="tabCount(v)" class="text-12 text-text-subtle tabular">{{ tabCount(v) }}</span>
        </button>
      </nav>
      <span class="flex-1" />
      <LoadingIndicator :active="current.refreshing.value" class="mb-2" />
      <BaseButton
        v-if="canManage"
        variant="secondary"
        class="mb-1.5"
        data-testid="new-silence"
        @click="router.replace({ query: { view: 'silences', new: 'silence' } })"
      >
        {{ $t('alerts.silence.new') }}
      </BaseButton>
    </div>

    <ErrorState
      v-if="current.error.value"
      :inline="current.loaded.value"
      :message="$t('alerts.errors.load')"
      :retrying="current.loading.value"
      @retry="current.load"
    />
    <div v-if="current.skeleton.value" class="flex flex-col gap-4" data-testid="alerts-skeleton">
      <div v-if="view === 'firing'" class="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Skeleton v-for="i in 4" :key="i" shape="rect" class="h-16" />
      </div>
      <SkeletonTable :columns="4" :label="$t('common.loading')" />
    </div>

    <!-- Firing -->
    <template v-else-if="view === 'firing' && firing.loaded.value">
      <p v-if="ruleFilter" class="text-13 text-text-muted">
        {{ $t('alerts.filteredByRule') }}
        <RouterLink :to="{ query: { ...route.query, rule: undefined } }" class="text-primary">
          {{ $t('alerts.showAll') }}
        </RouterLink>
      </p>
      <FiringView
        :list="firing.data.value!.list"
        :clusters="firing.data.value!.clusters"
        :can-manage="canManage"
        @changed="firing.load"
      />
    </template>

    <!-- History -->
    <template v-else-if="view === 'history' && history.loaded.value">
      <EmptyState
        v-if="historyItems.length === 0"
        :icon="History"
        :title="$t('alerts.empty.history.title')"
        :description="$t('alerts.empty.history.description')"
      />
      <template v-else>
        <AlertTable :alerts="historyItems" history />
        <BaseButton
          v-if="nextCursor"
          variant="secondary"
          class="self-center"
          :loading="loadingMore"
          data-testid="load-more"
          @click="loadMore"
        >
          {{ $t('alerts.loadMore') }}
        </BaseButton>
      </template>
    </template>

    <!-- Silences -->
    <template v-else-if="view === 'silences' && silences.loaded.value">
      <NewSilenceForm
        v-if="newSilence && canManage"
        :clusters="silences.data.value!.clusters"
        @done="silenceCreated"
        @cancel="router.replace({ query: { view: 'silences' } })"
      />
      <EmptyState
        v-if="silences.data.value!.silences.length === 0 && !newSilence"
        :icon="BellOff"
        :title="$t('alerts.empty.silences.title')"
        :description="$t('alerts.empty.silences.description')"
      />
      <ul
        v-else-if="silences.data.value!.silences.length"
        class="flex flex-col divide-y divide-border rounded-card border border-border bg-surface-1"
      >
        <li
          v-for="s in silences.data.value!.silences"
          :key="s.id"
          class="flex flex-wrap items-start gap-4 px-4 py-3"
          data-testid="silence-row"
        >
          <BellOff class="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap gap-1.5 text-13 text-text">
              <span
                v-for="(v, k) in s.matchers"
                :key="k"
                class="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-12"
              >
                {{ $t(`alerts.matchers.${k}`) }}:
                {{
                  k === 'cluster'
                    ? (silences.data.value!.clusters.find((c) => c.id === v)?.name ?? v)
                    : k === 'rule'
                      ? $t('alerts.matchers.thisRule')
                      : v
                }}
              </span>
            </p>
            <p class="mt-1 text-12 text-text-muted">
              {{ $t('alerts.silences.until', { at: formatDateTime(s.endsAt) }) }} ·
              {{ $t('alerts.silences.matching', { n: s.matching }, s.matching) }}
              <template v-if="s.comment"> · {{ s.comment }}</template>
            </p>
          </div>
          <BaseButton
            v-if="canManage"
            variant="ghost"
            :loading="ending === s.id"
            data-testid="end-silence"
            @click="endSilence(s.id)"
          >
            {{ $t('alerts.silences.end') }}
          </BaseButton>
        </li>
      </ul>
    </template>

    <!-- Rules -->
    <template v-else-if="view === 'rules' && rules.loaded.value">
      <EmptyState
        v-if="rules.data.value!.rules.length === 0"
        :icon="Bell"
        :title="$t('empty.alerts.title')"
        :description="$t('empty.alerts.description')"
      />
      <RulesView
        v-else
        :rules="rules.data.value!.rules"
        :channels="rules.data.value!.channels"
        :can-manage="canManage"
        @changed="rules.load"
        @open="openRule"
        @create="openRule(null)"
      />
      <RuleDrawer
        v-model:open="drawerOpen"
        :rule="editing"
        :channels="rules.data.value!.channels"
        :clusters="rules.data.value!.clusters"
        @saved="rules.load"
      />
    </template>
  </div>
</template>
