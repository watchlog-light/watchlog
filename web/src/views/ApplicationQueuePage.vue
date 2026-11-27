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

// One RabbitMQ queue (1.1.0, ADR-243), at its own address (/applications/:id/queues/:queue,
// ?vhost= outside the default): its tiles, depth against what is usual, in against acked,
// consumers and how busy, what happened, the probable cause, its facts and its alerts, with
// the service's time range.
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const id = computed(() => String(route.params.id));
const queue = computed(() => String(route.params.queue));
const vhost = computed(() => (typeof route.query.vhost === 'string' ? route.query.vhost : '/'));
const name = computed(() => (vhost.value === '/' ? queue.value : `${vhost.value}/${queue.value}`));
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
    `/applications/${id.value}/panels?tab=queue&queue=${encodeURIComponent(queue.value)}&vhost=${encodeURIComponent(vhost.value)}&range=${range.value}`,
  ),
);
const window = computed<[number, number]>(() => {
  const end = Math.floor(Date.now() / 1000);
  return [end - range.value, end];
});
const notFound = computed(
  () => page.error.value instanceof ApiError && page.error.value.status === 404,
);
// The queue's type and leader, from its facts card, for the line under its name.
const facts = computed(() => {
  const f = panels.data.value?.panels.find((p) => p.kind === 'facts');
  const rows = f?.kind === 'facts' ? f.rows : [];
  const of = (k: string) => rows.find((r) => r.labelKey.endsWith(`fact.${k}`))?.value ?? null;
  return { type: of('type'), leader: of('leader') };
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
watch([range, queue, vhost], () => {
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
  <div class="flex flex-col gap-5" data-testid="application-queue">
    <RouterLink
      :to="{ name: 'application', params: { id }, query: { tab: 'queues' } }"
      class="inline-flex items-center gap-1.5 self-start text-13 text-text-muted hover:text-text max-lg:min-h-11"
      data-testid="queue-back"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />{{
        app
          ? $t('integrations.rabbitmq.panels.backToQueues', { name: app.name })
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
              class="font-mono text-20 font-semibold break-all text-text"
              data-testid="queue-name"
            >
              {{ name }}
            </h2>
            <span class="flex flex-wrap items-center gap-1.5 text-13 text-text-muted">
              <template v-if="facts.type">{{ facts.type }} · </template>
              {{ $t('integrations.rabbitmq.panels.vhostIs', { vhost }) }}
              <template v-if="facts.leader">
                ·
                {{ $t('integrations.rabbitmq.panels.leaderIs', { node: facts.leader }) }}</template
              >
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
