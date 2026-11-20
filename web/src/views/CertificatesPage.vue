<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronRight, ShieldCheck } from '@lucide/vue';
import type { TlsCertificate } from '@watchlog/api-types';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import ApplicationsTabs from '@/components/applications/ApplicationsTabs.vue';
import SummaryTile from '@/components/applications/SummaryTile.vue';
import ToneChip from '@/components/applications/ToneChip.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SearchField from '@/components/ui/SearchField.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useLoader } from '@/composables/useLoader';
import { useNarrow } from '@/composables/useNarrow';
import {
  CERT_TONE,
  certDays,
  certTiles,
  day,
  filterCerts,
  lifetimeUsed,
  otherNames,
  renewal,
  servedBy,
  type CertFilter,
  type Tone,
  type Words,
} from '@/lib/certs-jobs';
import { useCertsJobsStore } from '@/stores/certsJobs';
import { useClustersStore } from '@/stores/clusters';

// Applications › Certificates (0.10, ADR-222): the selected cluster's or fleet's certificates,
// problems first, as in the reference: four tiles, the table (certificate, served by, issuer,
// expires with its days and a bar, renewal, status), what wasn't covered, the default alerts.
// Phones get one card per certificate.
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const narrow = useNarrow();
const store = useCertsJobsStore();
const clusters = useClustersStore();

const page = useLoader(async () => {
  await clusters.ensure();
  const c = clusters.selected;
  if (!c) return null;
  return { cluster: c, data: await store.loadCerts(c.id, true) };
});
onMounted(() => void page.load());
watch(
  () => clusters.selected?.id,
  () => void page.load(),
);

const kube = computed(() => page.data.value?.cluster.kind === 'kubernetes');
const list = computed(() => page.data.value?.data.certificates ?? []);
const filter = computed<CertFilter>(() =>
  route.query.show === 'attention' || route.query.show === 'ok' ? route.query.show : 'all',
);
const q = ref(typeof route.query.q === 'string' ? route.query.q : '');
const setQuery = (patch: Record<string, string | undefined>) =>
  void router.replace({ query: { ...route.query, ...patch } });
watch(q, (v) => setQuery({ q: v || undefined }));
const rows = computed(() => filterCerts(list.value, filter.value, q.value));
const tiles = computed(() => certTiles(list.value));
const counts = computed(() => ({
  all: list.value.length,
  attention: list.value.filter((c) => c.status !== 'ok').length,
  ok: list.value.filter((c) => c.status === 'ok').length,
}));

const say = (w: Words) => t(w.key, w.values ?? {}, Number(w.values?.n ?? 1));
const TEXT_TONE: Record<Tone, string> = {
  crit: 'text-critical',
  warn: 'text-warning',
  ok: 'text-text-muted',
  info: 'text-info',
  muted: 'text-text-muted',
};
const BAR_TONE: Record<Tone, string> = {
  crit: 'bg-critical',
  warn: 'bg-warning',
  ok: 'bg-ok',
  info: 'bg-info',
  muted: 'bg-text-subtle',
};
/** The expiry bar: red once it expires within 3 days, amber within 14, green otherwise. */
const barTone = (c: TlsCertificate): Tone =>
  c.status === 'expired' || c.status === 'expires_soon'
    ? 'crit'
    : c.status === 'expiring'
      ? 'warn'
      : 'ok';
const issuer = (c: TlsCertificate) => c.issuerOrg || c.issuer || '–';

const agents = computed(() => page.data.value?.data.agentsWithout ?? []);
const coverage = computed(() => page.data.value?.data.coverage ?? []);
const unserved = computed(() =>
  coverage.value.flatMap((c) =>
    ((c.certificates?.unserved as string[] | undefined) ?? []).map((n) =>
      c.node ? `${n} (${c.node})` : n,
    ),
  ),
);
const unreachable = computed(() =>
  coverage.value.reduce((n, c) => n + Number(c.certificates?.unreachable ?? 0), 0),
);
const overCap = computed(() =>
  coverage.value.reduce((n, c) => n + Number(c.certificates?.overCap ?? 0), 0),
);
const waiting = computed(
  () => page.loaded.value && coverage.value.length === 0 && agents.value.length === 0,
);
const columns =
  'grid-cols-[minmax(0,1.8fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,1.6fr)_6.5rem_1rem]';
</script>

<template>
  <div class="flex flex-col gap-5" data-testid="certificates">
    <ApplicationsTabs />

    <p
      v-if="agents.length > 0"
      class="rounded-card border border-info/40 bg-info/10 px-4 py-3 text-14 text-text"
      data-testid="needs-agent"
    >
      {{
        kube
          ? $t('certs.needsAgent.cluster', { version: agents[0]!.version })
          : $t(
              'certs.needsAgent.servers',
              {
                n: agents.length,
                names: agents
                  .slice(0, 5)
                  .map((a) => a.node)
                  .join(', '),
              },
              agents.length,
            )
      }}
    </p>

    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('certs.error')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <SkeletonTable
      v-if="page.skeleton.value"
      :columns="6"
      :rows="4"
      :label="$t('common.loading')"
    />

    <template v-else-if="page.loaded.value">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryTile
          :label="$t('certs.tiles.total')"
          :value="String(tiles.total)"
          :sub="
            kube
              ? $t('certs.tiles.inCluster')
              : $t('certs.tiles.onServers', { n: tiles.servers }, tiles.servers)
          "
        />
        <SummaryTile
          :label="$t('certs.tiles.expired')"
          :value="String(tiles.expired.length)"
          :tone="tiles.expired.length ? 'crit' : 'ok'"
          :sub="tiles.expired.map((c) => c.names[0]).join(', ') || $t('certs.tiles.none')"
        />
        <SummaryTile
          :label="$t('certs.tiles.expiring')"
          :value="String(tiles.expiring.length)"
          :tone="tiles.expiring.length ? 'warn' : 'ok'"
          :sub="
            tiles.expiring.length
              ? `${tiles.expiring[0]!.names[0]}, ${say(certDays(tiles.expiring[0]!))}`
              : $t('certs.tiles.none')
          "
        />
        <SummaryTile
          :label="$t('certs.tiles.renewing')"
          :value="$t('certs.tiles.renewingValue', { n: tiles.renewing, total: tiles.total })"
          :sub="$t('certs.tiles.renewingSub')"
        />
      </div>

      <EmptyState
        v-if="list.length === 0"
        :icon="ShieldCheck"
        :title="$t('certs.empty.title')"
        :description="waiting ? $t('certs.coverage.notYet') : $t('certs.empty.description')"
      />

      <template v-else>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div role="group" :aria-label="$t('certs.filters.label')" class="flex flex-wrap gap-1.5">
            <button
              v-for="f in ['all', 'attention', 'ok'] as const"
              :key="f"
              type="button"
              :aria-pressed="filter === f"
              :class="[
                'inline-flex h-8.5 items-center gap-1.5 rounded-full border px-3 text-13 font-medium max-lg:min-h-11',
                filter === f
                  ? 'border-border-strong bg-surface-3 text-text'
                  : 'border-border text-text-muted hover:bg-surface-2',
              ]"
              data-testid="cert-filter"
              @click="setQuery({ show: f === 'all' ? undefined : f })"
            >
              {{ $t(`certs.filters.${f}`) }}
              <span class="text-text-muted">{{ counts[f] }}</span>
            </button>
          </div>
          <SearchField
            v-model="q"
            class="min-w-56"
            :label="$t('certs.filters.search')"
            :placeholder="$t('certs.filters.search')"
            @clear="q = ''"
          />
        </div>

        <section class="overflow-hidden rounded-card border border-border bg-surface-1">
          <div
            v-if="!narrow"
            :class="[
              'grid gap-4 border-b border-border px-4 py-2.5 text-11 font-medium tracking-wider text-text-muted uppercase',
              columns,
            ]"
          >
            <span>{{ $t('certs.columns.certificate') }}</span>
            <span>{{ $t('certs.columns.servedBy') }}</span>
            <span>{{ $t('certs.columns.issuer') }}</span>
            <span>{{ $t('certs.columns.expires') }}</span>
            <span>{{ $t('certs.columns.renewal') }}</span>
            <span>{{ $t('certs.columns.status') }}</span>
            <span />
          </div>
          <p v-if="rows.length === 0" class="px-4 py-6 text-14 text-text-muted">
            {{ $t('certs.empty.filtered') }}
          </p>
          <ul data-testid="certificate-list">
            <li
              v-for="c in rows"
              :key="`${c.node}/${c.id}`"
              :class="[
                'border-t border-border first:border-t-0',
                CERT_TONE[c.status] === 'crit' ? 'bg-critical/5' : '',
              ]"
              data-testid="certificate-row"
            >
              <RouterLink
                :to="{
                  name: 'certificate',
                  params: { certId: c.id },
                  query: c.node ? { node: c.node } : {},
                }"
                :aria-label="$t('certs.open', { name: c.names[0] })"
                :class="[
                  'hover:bg-surface-2',
                  narrow
                    ? 'flex flex-col gap-2 px-4 py-3.5'
                    : ['grid items-center gap-4 px-4 py-3.5', columns],
                ]"
              >
                <span class="flex min-w-0 items-start justify-between gap-3">
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="truncate font-mono text-14 font-semibold text-text">{{
                      c.names[0]
                    }}</span>
                    <span class="truncate text-12 text-text-muted">{{ say(otherNames(c)) }}</span>
                  </span>
                  <ToneChip
                    v-if="narrow"
                    :tone="CERT_TONE[c.status]"
                    :label="$t(`certs.status.${c.status}`)"
                  />
                </span>
                <span class="truncate font-mono text-13 text-text-muted" data-testid="served-by">{{
                  say(servedBy(c))
                }}</span>
                <span v-if="!narrow" class="truncate text-13 text-text-muted">{{ issuer(c) }}</span>
                <span class="flex min-w-0 flex-col gap-1.5">
                  <span
                    :class="[
                      'text-14 font-semibold',
                      CERT_TONE[c.status] === 'crit'
                        ? 'text-critical'
                        : CERT_TONE[c.status] === 'warn' && c.status !== 'problem'
                          ? 'text-warning'
                          : 'text-text',
                    ]"
                    data-testid="days"
                    >{{ say(certDays(c)) }}
                    <span class="font-normal text-text-muted">· {{ day(c.notAfter) }}</span></span
                  >
                  <span class="h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
                    <span
                      :class="['block h-full rounded-full', BAR_TONE[barTone(c)]]"
                      :style="{ width: `${lifetimeUsed(c)}%` }"
                    />
                  </span>
                </span>
                <span
                  :class="['text-13 leading-snug', TEXT_TONE[renewal(c).tone]]"
                  data-testid="renewal"
                  >{{ say(renewal(c).words) }}</span
                >
                <span v-if="!narrow"
                  ><ToneChip :tone="CERT_TONE[c.status]" :label="$t(`certs.status.${c.status}`)"
                /></span>
                <ChevronRight v-if="!narrow" class="size-4 text-text-subtle" aria-hidden="true" />
              </RouterLink>
            </li>
          </ul>
        </section>
      </template>

      <ul
        v-if="unserved.length || unreachable || overCap"
        class="flex flex-col gap-1 text-13 text-text-muted"
        data-testid="coverage"
      >
        <li v-if="unserved.length">
          {{ $t('certs.coverage.unserved', { names: unserved.slice(0, 8).join(', ') }) }}
        </li>
        <li v-if="unreachable">
          {{ $t('certs.coverage.unreachable', { n: unreachable }, unreachable) }}
        </li>
        <li v-if="overCap">{{ $t('certs.coverage.overCap', { n: overCap }) }}</li>
      </ul>

      <section class="flex flex-col gap-2 rounded-card border border-border bg-surface-1 px-5 py-4">
        <h2 class="text-16 font-semibold text-text">{{ $t('certs.alertsNote.title') }}</h2>
        <p class="text-14 leading-relaxed text-text-muted">{{ $t('certs.alertsNote.text') }}</p>
        <p class="text-13 leading-relaxed text-text-muted">
          {{ kube ? $t('certs.alertsNote.howKube') : $t('certs.alertsNote.how') }}
        </p>
      </section>
    </template>
  </div>
</template>
