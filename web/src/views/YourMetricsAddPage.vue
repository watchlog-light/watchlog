<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Add a source of your own metrics (1.0.0, ADR-236; redrawn in 1.0.3 so a first-time user can
// follow it): a question first ("Where is your number?"), then the way it leads to, complete
// on one screen. Push opens unless an endpoint was found here or the user chose another way
// last time. A token is made inside the step that needs it and lives in this page only.
import type { OwnFound } from '@watchlog/api-types';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ownMetricsApi } from '@/api/own-metrics';
import ExposePanel from '@/components/own-metrics/add/ExposePanel.vue';
import PrometheusPanel from '@/components/own-metrics/add/PrometheusPanel.vue';
import PushPanel from '@/components/own-metrics/add/PushPanel.vue';
import type { MadeToken } from '@/components/own-metrics/add/TokenStep.vue';
import WayChooser from '@/components/own-metrics/add/WayChooser.vue';
import SourcesTable from '@/components/own-metrics/SourcesTable.vue';
import TokensCard from '@/components/own-metrics/TokensCard.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useLoader } from '@/composables/useLoader';
import { usePolling } from '@/composables/usePolling';
import { LINKS } from '@/lib/links';
import { firstWay, rememberedWay, rememberWay, WAYS } from '@/lib/own-add';
import type { Way } from '@/lib/own-metrics';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';

/** How long the page waits for the quiet search before it opens Push. */
const FIND_WAIT_MS = 4000;

const route = useRoute();
const router = useRouter();
const clusters = useClustersStore();
const auth = useAuthStore();

const page = useLoader(async () => {
  await clusters.ensure();
  const c = clusters.selected;
  if (!c) return null;
  return { cluster: c, summary: await ownMetricsApi.summary(c.id) };
});
// The sources table fills as endpoints report: read again every 30 s while visible.
const poll = usePolling(() => page.load(), 30_000);
poll.start();

const data = computed(() => page.data.value);
const limits = computed(() => data.value?.summary.limits);
const usedShare = computed(() => {
  const s = data.value?.summary;
  return s && s.limits.series > 0 ? Math.min(100, (s.usage.series / s.limits.series) * 100) : 0;
});

// ------------------------------------------------------------------ which way is open
const way = ref<Way | null>(null);
const found = ref<OwnFound | null>(null);
const looking = ref(false);

/** "Find endpoints for me", quietly: an answer still held, else a new search, for a moment. */
async function quietFind(cluster: string): Promise<OwnFound | null> {
  if (!auth.canManage) return null;
  let f: OwnFound;
  try {
    f = await ownMetricsApi.found(cluster);
  } catch {
    try {
      f = await ownMetricsApi.find(cluster);
    } catch {
      return null;
    }
  }
  const until = Date.now() + FIND_WAIT_MS;
  while (!f.done && f.asked > 0 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      f = await ownMetricsApi.found(cluster);
    } catch {
      break;
    }
  }
  return f;
}

async function open() {
  await page.load();
  const c = data.value?.cluster.id;
  if (!c) return;
  const query = route.query.way;
  const remembered = rememberedWay();
  const decided = WAYS.includes(query as Way) || remembered !== null;
  if (decided) way.value = firstWay({ query, remembered, found: null });
  // The search runs either way: Expose lists what it found, the question says how many.
  looking.value = !decided;
  const f = await quietFind(c);
  if (data.value?.cluster.id !== c) return;
  found.value = f;
  looking.value = false;
  if (!way.value) way.value = firstWay({ query, remembered, found: f });
}
onMounted(() => void open());
watch(
  () => clusters.selected?.id,
  (id, before) => {
    if (!before || id === before) return;
    // Another place: its own endpoints, its own tokens. A token made for the first one stays there.
    way.value = null;
    found.value = null;
    made.value = null;
    watched.value = null;
    void open();
  },
);

/** The user's own choice: remembered for next time, and in the address for a shared link. */
function setWay(w: Way) {
  way.value = w;
  rememberWay(w);
  void router.replace({ query: { ...route.query, way: w } });
}

// ------------------------------------------------------------------ the token of this visit
// Its value is kept here and nowhere else: not in the address, not in storage.
const made = ref<MadeToken | null>(null);
const watched = ref<string | null>(null);
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-5" data-testid="own-add-page">
    <nav class="text-13 text-text-muted" :aria-label="$t('ownMetrics.add.breadcrumb')">
      <RouterLink
        :to="{ name: 'your-metrics', query: { cluster: route.query.cluster } }"
        class="text-link hover:underline"
        >{{ $t('nav.yourMetrics') }}</RouterLink
      >
      / {{ $t('ownMetrics.addSource') }}
    </nav>
    <header>
      <h1 class="text-20 font-semibold text-text">{{ $t('ownMetrics.addSource') }}</h1>
      <p class="mt-2 max-w-2xl text-14 leading-relaxed text-text-muted">
        {{ $t('ownMetrics.add.intro') }}
      </p>
    </header>

    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('ownMetrics.error')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <SkeletonTable v-else-if="!page.loaded.value" :label="$t('common.loading')" />
    <template v-else-if="data && limits">
      <p
        v-if="!auth.canManage"
        class="rounded-card border border-border bg-surface-1 px-4 py-3 text-13 leading-relaxed text-text-muted"
        data-testid="own-add-readonly"
      >
        {{ $t(auth.demoMode ? 'ownMetrics.add.demo' : 'ownMetrics.add.viewer') }}
      </p>

      <WayChooser
        :model-value="way"
        :found="found?.found.length ?? 0"
        @update:model-value="setWay"
      />

      <div
        role="tablist"
        class="flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--border)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        :aria-label="$t('ownMetrics.add.ways')"
      >
        <button
          v-for="w in WAYS"
          :key="w"
          type="button"
          role="tab"
          :aria-selected="way === w"
          :class="[
            'min-h-10 shrink-0 border-b-2 px-3 text-14 whitespace-nowrap max-lg:min-h-11',
            way === w
              ? 'border-primary font-semibold text-text'
              : 'border-transparent text-text-muted hover:text-text',
          ]"
          :data-testid="`own-add-way-${w}`"
          @click="setWay(w)"
        >
          {{ $t(`ownMetrics.ways.${w}.title`) }}
        </button>
      </div>

      <!-- grid-cols-1: one column that may shrink, so a snippet scrolls in its block on a phone
           instead of widening the page. -->
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section
          class="min-w-0 rounded-card border border-border bg-surface-1 px-5 py-5"
          role="tabpanel"
          :data-testid="way ? `own-add-panel-${way}` : 'own-add-panel-deciding'"
        >
          <p
            v-if="!way"
            class="text-14 text-text-muted"
            role="status"
            data-testid="own-add-looking"
          >
            {{ $t('ownMetrics.add.chooser.looking') }}
          </p>
          <PushPanel
            v-else-if="way === 'push'"
            :cluster="data.cluster.id"
            :summary="data.summary"
            :made="made"
            :watching="watched"
            @made="made = $event"
            @watch="watched = $event"
            @changed="page.load"
          />
          <ExposePanel
            v-else-if="way === 'scrape'"
            :cluster="data.cluster.id"
            :summary="data.summary"
            :found="found"
            @changed="page.load"
            @push="setWay('push')"
          />
          <PrometheusPanel
            v-else
            :cluster="data.cluster.id"
            :summary="data.summary"
            :made="made"
            :watching="watched"
            @made="made = $event"
            @watch="watched = $event"
            @changed="page.load"
          />
        </section>

        <aside class="flex min-w-0 flex-col gap-4">
          <section
            class="rounded-card border border-border bg-surface-1 px-5 py-4"
            data-testid="own-plan"
          >
            <h3 class="text-11 font-medium tracking-[0.08em] text-text-subtle uppercase">
              {{ $t('ownMetrics.add.limits.onPlan') }}
            </h3>
            <p class="mt-2 text-14 text-text-muted" data-testid="own-plan-series">
              <i18n-t keypath="ownMetrics.add.limits.used" tag="span">
                <template #used>
                  <b class="text-20 font-bold text-text">{{
                    data.summary.usage.series.toLocaleString('en-US')
                  }}</b>
                </template>
                <template #max>{{ limits.series.toLocaleString('en-US') }}</template>
              </i18n-t>
            </p>
            <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
              <div class="h-full rounded-full bg-primary" :style="{ width: `${usedShare}%` }" />
            </div>
            <p
              class="mt-3 text-13 leading-relaxed text-text-muted"
              data-testid="own-series-meaning"
            >
              {{ $t('ownMetrics.add.limits.series') }}
            </p>
          </section>
          <section
            v-if="way"
            class="rounded-card border border-border bg-surface-1 px-5 py-4"
            data-testid="own-next"
          >
            <h3 class="text-14 font-semibold text-text">{{ $t('ownMetrics.add.next.title') }}</h3>
            <ol
              class="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-13 leading-relaxed text-text-muted"
            >
              <li v-for="i in 3" :key="i">{{ $t(`ownMetrics.add.next.${way}[${i - 1}]`) }}</li>
            </ol>
          </section>
          <section
            class="rounded-card border border-border bg-surface-1 px-5 py-4"
            data-testid="own-limits"
          >
            <h3 class="text-14 font-semibold text-text">{{ $t('ownMetrics.add.limits.title') }}</h3>
            <ul class="mt-2 flex flex-col gap-1.5 text-13 leading-relaxed text-text-muted">
              <li v-if="limits.sources !== null" data-testid="own-limits-sources">
                {{
                  $t('ownMetrics.add.limits.sources', {
                    max: limits.sources,
                    used: data.summary.usage.sources,
                  })
                }}
              </li>
              <li>{{ $t('ownMetrics.add.limits.source', { max: limits.seriesPerSource }) }}</li>
              <li data-testid="own-limits-remote-write">
                {{ $t('ownMetrics.add.limits.remoteWrite') }}
              </li>
              <li>{{ $t('ownMetrics.add.limits.labels') }}</li>
              <li>{{ $t('ownMetrics.add.limits.full') }}</li>
            </ul>
          </section>
          <section
            v-if="way !== 'scrape'"
            class="rounded-card border border-border bg-surface-1 px-5 py-4"
            data-testid="own-stuck"
          >
            <h3 class="text-14 font-semibold text-text">{{ $t('ownMetrics.add.stuck.title') }}</h3>
            <p class="mt-2 text-13 leading-relaxed text-text-muted">
              {{ $t('ownMetrics.add.stuck.codes') }}
              <a
                :href="LINKS.firstMetric"
                target="_blank"
                rel="noopener"
                class="text-link hover:underline"
                >{{ $t('ownMetrics.add.stuck.docs') }} →</a
              >
            </p>
          </section>
        </aside>
      </div>

      <TokensCard
        v-if="data.summary.tokens.length > 0"
        list-only
        :cluster="data.cluster.id"
        :summary="data.summary"
        @changed="page.load"
      />
      <SourcesTable :cluster="data.cluster.id" :summary="data.summary" @changed="page.load" />
    </template>
  </div>
</template>
