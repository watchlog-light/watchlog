<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Add a source of your own metrics (1.0.0, ADR-236): three ways in, each with what to copy
// (the real address, the token just made), what happens next and the limits; then the tokens
// and every source with what it brought and what was dropped.
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import { ownMetricsApi } from '@/api/own-metrics';
import FindEndpoints from '@/components/own-metrics/FindEndpoints.vue';
import SourcesTable from '@/components/own-metrics/SourcesTable.vue';
import TokensCard from '@/components/own-metrics/TokensCard.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import TextField from '@/components/ui/TextField.vue';
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue';
import { useLoader } from '@/composables/useLoader';
import { usePolling } from '@/composables/usePolling';
import {
  annotationSnippet,
  pushSnippet,
  remoteWriteSnippet,
  TOKEN_PLACEHOLDER,
  type Way,
} from '@/lib/own-metrics';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';

const WAYS: Way[] = ['scrape', 'prometheus', 'push'];
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const clusters = useClustersStore();
const auth = useAuthStore();

const page = useLoader(async () => {
  await clusters.ensure();
  const c = clusters.selected;
  if (!c) return null;
  return { cluster: c, summary: await ownMetricsApi.summary(c.id) };
});
onMounted(() => void page.load());
watch(
  () => clusters.selected?.id,
  () => void page.load(),
);
// The sources table fills as endpoints report: read again every 30 s while visible.
const poll = usePolling(() => page.load(), 30_000);
poll.start();

const way = computed<Way>(() => {
  const q = route.query.way;
  return WAYS.includes(q as Way) ? (q as Way) : 'scrape';
});
const setWay = (w: Way) =>
  void router.replace({ query: { ...route.query, way: w === 'scrape' ? undefined : w } });

const data = computed(() => page.data.value);
const kube = computed(() => data.value?.summary.kind === 'kubernetes');
const limits = computed(() => data.value?.summary.limits);

// The token just made goes into the snippets; it is never read back from the server.
const token = ref('');
const shownToken = computed(() => token.value || TOKEN_PLACEHOLDER);
const snippet = computed(() => {
  const s = data.value?.summary;
  if (!s) return '';
  if (way.value === 'prometheus') return remoteWriteSnippet(s.endpoint, shownToken.value);
  if (way.value === 'push') return pushSnippet(s.endpoint, shownToken.value, s.kind);
  return annotationSnippet();
});

// ------------------------------------------------------------------ the cluster's setting
const prom = computed<boolean>({
  get: () => data.value?.summary.settings.prometheusAnnotations ?? false,
  set: (v) => {
    const c = data.value?.cluster.id;
    if (!c) return;
    void ownMetricsApi.settings(c, v).then(
      () => page.load(),
      (err: unknown) => (formError.value = words(err)),
    );
  },
});

// ------------------------------------------------------------------ an address on a server
const server = ref<string | null>(null);
const address = ref('');
const formError = ref('');
const adding = ref(false);
const words = (err: unknown) =>
  (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.add.failed');
const serverOptions = computed(() =>
  (data.value?.summary.servers ?? []).map((s) => ({ value: s, label: s })),
);
watch(serverOptions, (list) => {
  if (!server.value && list.length === 1) server.value = list[0]!.value;
});
async function addAddress() {
  formError.value = '';
  if (!server.value || !address.value.trim()) {
    formError.value = t('ownMetrics.add.addressNeeded');
    return;
  }
  adding.value = true;
  try {
    await ownMetricsApi.addSource(data.value!.cluster.id, {
      server: server.value,
      address: address.value.trim(),
    });
    address.value = '';
    await page.load();
  } catch (err) {
    formError.value = words(err);
  } finally {
    adding.value = false;
  }
}
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
      <div role="tablist" class="grid gap-3 md:grid-cols-3" :aria-label="$t('ownMetrics.add.ways')">
        <button
          v-for="w in WAYS"
          :key="w"
          type="button"
          role="tab"
          :aria-selected="way === w"
          :class="[
            'flex flex-col gap-1 rounded-card border px-4 py-3.5 text-left transition-colors',
            way === w
              ? 'border-primary bg-primary/10'
              : 'border-border bg-surface-1 hover:bg-surface-2',
          ]"
          :data-testid="`own-add-way-${w}`"
          @click="setWay(w)"
        >
          <span class="text-14 font-semibold text-text">{{
            $t(`ownMetrics.ways.${w}.title`)
          }}</span>
          <span class="text-13 leading-relaxed text-text-muted">{{
            $t(`ownMetrics.ways.${w}.sub`)
          }}</span>
        </button>
      </div>

      <!-- grid-cols-1: one column that may shrink, so a snippet scrolls in its block on a phone
           instead of widening the page. -->
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section
          class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 px-5 py-5"
          role="tabpanel"
          :data-testid="`own-add-panel-${way}`"
        >
          <!-- Scrape, in a cluster: annotate the pod. -->
          <template v-if="way === 'scrape' && kube">
            <h2 class="text-16 font-semibold text-text">
              {{ $t('ownMetrics.add.scrape.kube.h') }}
            </h2>
            <p class="text-14 leading-relaxed text-text-muted">
              {{ $t('ownMetrics.add.scrape.kube.p') }}
            </p>
            <CodeBlock :code="snippet" :label="$t('ownMetrics.add.scrape.kube.code')" />
            <ToggleSwitch v-if="auth.canManage" v-model="prom" data-testid="own-prom-toggle">
              {{ $t('ownMetrics.add.scrape.kube.prometheus') }}
            </ToggleSwitch>
            <p v-else-if="prom" class="text-13 text-text-muted">
              {{ $t('ownMetrics.add.scrape.kube.prometheusOn') }}
            </p>
            <FindEndpoints v-if="auth.canManage" :cluster="data.cluster.id" @changed="page.load" />
          </template>
          <!-- Scrape, on a fleet: an address on one server. -->
          <template v-else-if="way === 'scrape'">
            <h2 class="text-16 font-semibold text-text">
              {{ $t('ownMetrics.add.scrape.server.h') }}
            </h2>
            <p class="text-14 leading-relaxed text-text-muted">
              {{ $t('ownMetrics.add.scrape.server.p') }}
            </p>
            <form
              v-if="auth.canManage"
              class="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]"
              data-testid="own-address-form"
              @submit.prevent="addAddress"
            >
              <label class="flex flex-col gap-1.5 text-13 text-text-muted">
                {{ $t('ownMetrics.add.scrape.server.server') }}
                <ComboBox
                  v-model="server"
                  :options="serverOptions"
                  :label="$t('ownMetrics.add.scrape.server.server')"
                  :placeholder="$t('ownMetrics.add.scrape.server.pick')"
                  testid="own-address-server"
                />
              </label>
              <TextField
                v-model="address"
                mono
                :label="$t('ownMetrics.add.scrape.server.address')"
                placeholder="localhost:9400/metrics"
              />
              <BaseButton type="submit" :loading="adding" data-testid="own-address-add">
                {{ $t('ownMetrics.add.scrape.server.add') }}
              </BaseButton>
            </form>
            <FindEndpoints v-if="auth.canManage" :cluster="data.cluster.id" @changed="page.load" />
          </template>
          <!-- Prometheus remote write and pushes: a token, then what to copy. -->
          <template v-else>
            <h2 class="text-16 font-semibold text-text">{{ $t(`ownMetrics.add.${way}.h`) }}</h2>
            <p class="text-14 leading-relaxed text-text-muted">
              {{ $t(`ownMetrics.add.${way}.p`) }}
            </p>
            <CodeBlock :code="snippet" :label="$t(`ownMetrics.add.${way}.code`)" />
            <p v-if="!token" class="text-13 text-text-muted" data-testid="own-token-hint">
              {{ $t('ownMetrics.add.tokenHint') }}
            </p>
            <p v-if="way === 'push'" class="text-13 leading-relaxed text-text-muted">
              {{ $t('ownMetrics.add.push.more') }}
            </p>
          </template>
          <p
            v-if="formError"
            class="text-13 text-critical-text"
            role="alert"
            data-testid="own-add-error"
          >
            {{ formError }}
          </p>
        </section>

        <aside class="flex flex-col gap-4">
          <section class="rounded-card border border-border bg-surface-1 px-5 py-4">
            <h3 class="text-14 font-semibold text-text">{{ $t('ownMetrics.add.next.title') }}</h3>
            <ol
              class="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-13 leading-relaxed text-text-muted"
            >
              <li>{{ $t(`ownMetrics.add.next.${way}`) }}</li>
              <li>{{ $t('ownMetrics.add.next.appears') }}</li>
              <li>{{ $t('ownMetrics.add.next.use') }}</li>
            </ol>
          </section>
          <section
            class="rounded-card border border-border bg-surface-1 px-5 py-4"
            data-testid="own-limits"
          >
            <h3 class="text-14 font-semibold text-text">{{ $t('ownMetrics.add.limits.title') }}</h3>
            <ul class="mt-2 flex flex-col gap-1.5 text-13 leading-relaxed text-text-muted">
              <li>{{ $t('ownMetrics.add.limits.source', { max: limits.seriesPerSource }) }}</li>
              <li>
                {{
                  $t('ownMetrics.add.limits.plan', {
                    max: limits.series.toLocaleString('en-US'),
                    used: data.summary.usage.series.toLocaleString('en-US'),
                  })
                }}
              </li>
              <li v-if="limits.sources !== null">
                {{ $t('ownMetrics.add.limits.sources', { max: limits.sources }) }}
              </li>
              <li>{{ $t('ownMetrics.add.limits.labels') }}</li>
              <li>{{ $t('ownMetrics.add.limits.readOnly') }}</li>
            </ul>
          </section>
        </aside>
      </div>

      <TokensCard
        v-if="way !== 'scrape' || data.summary.tokens.length > 0"
        :cluster="data.cluster.id"
        :summary="data.summary"
        @changed="page.load"
        @made="(v) => (token = v)"
      />
      <SourcesTable :cluster="data.cluster.id" :summary="data.summary" @changed="page.load" />
    </template>
  </div>
</template>
