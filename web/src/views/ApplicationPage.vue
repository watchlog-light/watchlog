<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowLeft, Database, Network, PauseCircle, Settings2 } from '@lucide/vue';
import type { ApplicationDetail, ApplicationPanels } from '@watchlog/api-types';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api } from '@/api/client';
import ServiceAlerts from '@/components/applications/ServiceAlerts.vue';
import CausePanel from '@/components/causes/CausePanel.vue';
import SettingsDrawer from '@/components/applications/SettingsDrawer.vue';
import ServicePanel from '@/components/panels/ServicePanel.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonChart from '@/components/ui/SkeletonChart.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import LockedControl from '@/components/ui/LockedControl.vue';
import { KIND_LOGO } from '@/components/ui/kindLogos';
import { ServiceLogo } from '@/components/ui/serviceLogos';
import { useLoader } from '@/composables/useLoader';
import {
  connectedLink,
  productText,
  reasonLine,
  serviceMapLink,
  serviceName,
} from '@/lib/applications';
import { formatDateTime } from '@/lib/format';
import { PAGE_RANGES, rangeOf, SEVERITY_TOKEN } from '@/lib/panels';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';

// A monitored service (SPEC §4.12, ADR-135; the mock-up's detail): the header with its
// own time range, "What WatchLog sees" (ADR-137), the integration's tabs (?tab=) with
// their panels in a two-column grid, then the workloads that connect to it and the MCP
// hint. A service whose integration hasn't landed has the generic Overview.
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const id = computed(() => String(route.params.id));
const range = computed(() => rangeOf(route.query.range));

const page = useLoader(() =>
  api<ApplicationDetail>(`/applications/${id.value}?range=${range.value}`),
);
const app = computed(() => page.data.value?.application);
const tabs = computed(() => page.data.value?.page.tabs ?? []);
const tab = computed(() => {
  const asked = typeof route.query.tab === 'string' ? route.query.tab : '';
  return tabs.value.find((x) => x.id === asked)?.id ?? tabs.value[0]?.id ?? 'overview';
});
const panels = useLoader(() =>
  api<ApplicationPanels>(
    `/applications/${id.value}/panels?tab=${encodeURIComponent(tab.value)}&range=${range.value}`,
  ),
);
// The page's window, for the charts' x axis: the same alignment as the server's.
const window = computed<[number, number]>(() => {
  const end = Math.floor(Date.now() / 1000);
  return [end - range.value, end];
});

const notFound = computed(
  () => page.error.value instanceof ApiError && page.error.value.status === 404,
);

onMounted(async () => {
  await page.load();
  if (page.data.value) await panels.load();
});
watch(range, () => {
  void page.load();
  void panels.load();
});
watch(tab, () => void panels.load());
watch(id, async () => {
  await page.load();
  void panels.load();
});

function setQuery(patch: Record<string, string | undefined>) {
  void router.replace({ query: { ...route.query, ...patch } });
}

const where = computed(() => {
  const a = app.value;
  if (!a) return '';
  if (a.where.address) return a.where.address;
  if (a.cluster.kind === 'kubernetes')
    return t('integrations.page.namespace', { namespace: a.where.group });
  return a.where.group
    ? t('integrations.page.hostProject', { host: a.where.host, project: a.where.group })
    : t('integrations.page.host', { host: a.where.host });
});

const HEALTH_STYLE = {
  ok: 'bg-ok/15 text-ok',
  warning: 'bg-warning/15 text-warning',
  critical: 'bg-critical/15 text-critical',
  unknown: 'bg-surface-3 text-text-muted',
} as const;
const reasons = computed(() =>
  (page.data.value?.reasons ?? []).map((r) => ({
    severity: r.severity,
    text: reasonLine(r, app.value!.cluster, (iso) => formatDateTime(iso)),
    // A command or configuration to apply (stub_status, ingress-nginx's metrics).
    command: typeof r.facts.command === 'string' && r.facts.command ? r.facts.command : null,
  })),
);
const connected = computed(() => page.data.value?.connected ?? null);
const settingsOpen = ref(false);

const toast = useToastStore();
const resuming = ref(false);
async function resume() {
  resuming.value = true;
  try {
    await api(`/applications/${id.value}`, { method: 'PATCH', body: { paused: false } });
    toast.show(t('integrations.page.paused.resumed', { name: app.value!.name }));
    await page.load();
    void panels.load();
  } catch (err) {
    toast.show(err instanceof ApiError ? err.message : String(err), 'warning');
  } finally {
    resuming.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-5" data-testid="application">
    <RouterLink
      :to="{ name: 'applications' }"
      class="inline-flex items-center gap-1.5 self-start text-13 text-text-muted hover:text-text max-lg:min-h-11"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />{{ $t('nav.applications') }}
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
            <div class="flex flex-wrap items-center gap-2.5">
              <h2
                class="font-mono text-20 font-semibold break-all text-text"
                data-testid="application-name"
              >
                {{ app.name }}
              </h2>
              <span
                :class="[
                  'inline-flex h-5.5 items-center rounded-full px-2.5 text-12 font-semibold',
                  HEALTH_STYLE[app.health],
                ]"
                data-testid="health"
                >{{ $t(`applications.health.${app.health}`) }}</span
              >
            </div>
            <span class="flex flex-wrap items-center gap-1.5 text-13 text-text-muted">
              {{ $t(productText(app).key, productText(app).values) }} ·
              <component :is="KIND_LOGO[app.cluster.kind]" class="size-3.5" aria-hidden="true" />
              {{ app.cluster.name }} · {{ where }} ·
              {{ $t('integrations.page.since', { at: formatDateTime(app.monitoredSince) }) }}
            </span>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div
            role="group"
            :aria-label="$t('integrations.page.range')"
            class="flex gap-0.5 rounded-control border border-border bg-surface-1 p-0.5"
          >
            <button
              v-for="r in PAGE_RANGES"
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
              @click="setQuery({ range: r.seconds === 3600 ? undefined : String(r.seconds) })"
            >
              {{ r.label }}
            </button>
          </div>
          <RouterLink
            :to="serviceMapLink(app)"
            class="inline-flex h-10 items-center gap-2 rounded-control border border-border-strong bg-surface-1 px-3.5 text-13 font-medium text-text hover:bg-surface-2 max-lg:h-11"
            data-testid="open-service-map"
          >
            <Network class="size-4" aria-hidden="true" />{{ $t('integrations.page.openMap') }}
          </RouterLink>
          <button
            type="button"
            class="inline-flex h-10 items-center gap-2 rounded-control border border-border-strong bg-surface-1 px-3.5 text-13 font-medium text-text hover:bg-surface-2 max-lg:h-11"
            data-testid="open-settings"
            @click="settingsOpen = true"
          >
            <Settings2 class="size-4" aria-hidden="true" />{{ $t('integrations.page.settings') }}
          </button>
        </div>
      </header>

      <!-- Paused: why nothing new arrives, and the way back (on the list too). -->
      <section
        v-if="app.reason.code === 'paused'"
        class="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-card border border-warning/40 bg-warning/5 px-4 py-3.5 sm:px-5"
        data-testid="paused"
      >
        <PauseCircle class="size-5 shrink-0 text-warning" aria-hidden="true" />
        <div class="flex min-w-0 flex-[1_1_18rem] flex-col gap-0.5">
          <span class="text-14 font-semibold text-text">{{
            $t('integrations.page.paused.title')
          }}</span>
          <span class="text-13 text-text-muted">{{
            app.reason.facts.by && app.reason.facts.at
              ? $t('integrations.page.paused.by', {
                  by: app.reason.facts.by,
                  at: formatDateTime(String(app.reason.facts.at)),
                })
              : $t('integrations.page.paused.unknown')
          }}</span>
          <span v-if="!auth.canManage" class="text-13 text-text-muted">{{
            $t('integrations.page.paused.howTo')
          }}</span>
        </div>
        <LockedControl>
          <BaseButton :loading="resuming" data-testid="resume" @click="resume">
            {{ $t('integrations.page.paused.resume') }}
          </BaseButton>
        </LockedControl>
      </section>

      <section
        :aria-label="$t('integrations.page.sees')"
        class="flex flex-col gap-2.5 rounded-card border border-border bg-surface-1 px-4 py-3.5 sm:px-5"
        data-testid="reasons"
      >
        <span class="text-12 font-semibold tracking-wider text-text-muted uppercase">{{
          $t('integrations.page.sees')
        }}</span>
        <ul class="flex flex-col gap-2">
          <li
            v-for="(r, i) in reasons"
            :key="i"
            class="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-2.5"
            data-testid="reason"
          >
            <span
              class="mt-1.5 size-2.5 rounded-full"
              :style="{
                background: `var(${SEVERITY_TOKEN[r.severity]})`,
                boxShadow: `0 0 0 4px color-mix(in srgb, var(${SEVERITY_TOKEN[r.severity]}) 18%, transparent)`,
              }"
              aria-hidden="true"
            />
            <span class="flex min-w-0 flex-col gap-2 text-14 leading-relaxed text-text">
              <span>
                <span class="sr-only">{{ $t(`integrations.severity.${r.severity}`) }}: </span>
                {{ $t(r.text.key, r.text.values) }}
              </span>
              <CodeBlock
                v-if="r.command"
                wrap
                :code="r.command"
                :label="$t('applications.access.commandLabel')"
                data-testid="reason-command"
              />
            </span>
          </li>
        </ul>
      </section>

      <!-- Beside the finding: what caused it (ADR-148), e.g. a queue's consumer OOM-killed. -->
      <CausePanel
        v-if="app.finding"
        :key="app.id"
        :cluster-id="app.cluster.id"
        :subject="`application:${app.id}`"
        :name="app.name"
      />

      <section
        v-if="page.data.value?.collectorCommand && auth.canManage"
        class="flex flex-col gap-2 rounded-card border border-border bg-surface-1 px-4 py-3.5 sm:px-5"
        data-testid="collector-command"
      >
        <h3 class="text-14 font-semibold text-text">
          {{ $t('integrations.page.startCollector', { host: app.where.host }) }}
        </h3>
        <p class="text-13 text-text-muted">{{ $t('integrations.page.startCollectorHint') }}</p>
        <CodeBlock
          wrap
          :code="page.data.value.collectorCommand"
          :label="$t('applications.access.commandLabel')"
        />
      </section>

      <div
        v-if="tabs.length > 1"
        role="tablist"
        :aria-label="$t('integrations.page.sections')"
        class="flex gap-0.5 overflow-x-auto border-b border-border"
      >
        <button
          v-for="tb in tabs"
          :key="tb.id"
          type="button"
          role="tab"
          :aria-selected="tab === tb.id"
          :class="[
            '-mb-px border-b-2 px-3.5 py-2.5 text-13 font-medium whitespace-nowrap max-lg:min-h-11',
            tab === tb.id
              ? 'border-primary text-text'
              : 'border-transparent text-text-muted hover:text-text',
          ]"
          data-testid="tab"
          @click="setQuery({ tab: tb.id === tabs[0]?.id ? undefined : tb.id })"
        >
          {{ $t(tb.title) }}
        </button>
      </div>
      <p
        v-if="page.data.value?.page.id === 'generic'"
        class="text-13 text-text-muted"
        data-testid="generic-note"
      >
        {{
          $te(`integrations.page.genericWhat.${app.type}`)
            ? $t(`integrations.page.genericWhat.${app.type}`)
            : $t('integrations.page.generic', { service: serviceName(app.type) })
        }}
      </p>

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
        role="tabpanel"
        class="grid gap-3.5 md:grid-cols-2"
        :aria-busy="panels.loading.value ? 'true' : undefined"
        data-testid="panels"
      >
        <ServicePanel
          v-for="p in panels.data.value.panels"
          :key="`${panels.data.value.tab}-${p.id}`"
          :panel="p"
          :window="window"
          :loading="panels.loading.value"
          :error="!!panels.error.value"
          :class="['min-w-0', p.span === 2 ? 'md:col-span-2' : '']"
          @retry="panels.load"
        />
      </div>

      <div class="flex flex-wrap items-start gap-3.5">
        <ServiceAlerts :app="app" />
        <section
          class="flex min-w-0 flex-[1_1_18rem] flex-col gap-3 rounded-card border border-border bg-surface-1 px-4 py-4 sm:px-5"
          data-testid="connected"
        >
          <h3 class="text-14 font-semibold text-text">
            {{ $t(`integrations.page.connected.${app.cluster.kind}`) }}
          </h3>
          <span class="text-12 text-text-muted">{{ $t('integrations.page.connected.from') }}</span>
          <p v-if="connected === null" class="text-13 text-text-subtle">
            {{ $t('integrations.page.connected.unavailable') }}
          </p>
          <p v-else-if="!connected.flows" class="text-13 text-text-subtle">
            {{ $t('integrations.page.connected.noFlows') }}
          </p>
          <p v-else-if="connected.items.length === 0" class="text-13 text-text-subtle">
            {{ $t('integrations.page.connected.none') }}
          </p>
          <ul v-else class="flex flex-col gap-2">
            <li v-for="c in connected.items" :key="`${c.namespace}/${c.name}`">
              <component
                :is="connectedLink(c, app.cluster.id) ? 'RouterLink' : 'div'"
                :to="connectedLink(c, app.cluster.id)"
                class="flex items-center justify-between gap-3 rounded-control border border-border bg-bg px-3 py-2.5 hover:bg-surface-2 max-lg:min-h-11"
                data-testid="connected-item"
              >
                <span class="truncate font-mono text-13 text-text">{{
                  c.namespace ? `${c.namespace}/${c.name}` : c.name
                }}</span>
                <span
                  :class="['shrink-0 text-12', c.failed > 0 ? 'text-warning' : 'text-text-muted']"
                >
                  {{
                    $t(
                      'integrations.page.connected.connections',
                      { n: c.connections },
                      c.connections,
                    )
                  }}<template v-if="c.failed > 0">
                    ·
                    {{
                      $t('integrations.page.connected.failed', { n: c.failed }, c.failed)
                    }}</template
                  >
                </span>
              </component>
            </li>
          </ul>
          <div class="mt-1 flex flex-col gap-1 border-t border-border pt-3">
            <span class="text-12 font-semibold text-text">{{
              $t('integrations.page.mcp.title')
            }}</span>
            <span class="text-12 text-text-muted">
              {{ $t('integrations.page.mcp.body') }}
              <code class="font-mono text-text">get_application</code>
            </span>
          </div>
        </section>
      </div>
      <SettingsDrawer
        v-if="settingsOpen"
        v-model:open="settingsOpen"
        :app="app"
        @changed="page.load"
      />
    </template>
  </div>
</template>
