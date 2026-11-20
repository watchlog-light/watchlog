<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowLeft, ShieldAlert } from '@lucide/vue';
import type { CertificateDetail } from '@watchlog/api-types';
import { computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api, ApiError } from '@/api/client';
import ToneChip from '@/components/applications/ToneChip.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import { useLoader } from '@/composables/useLoader';
import { CERT_TONE, certDays, certProblems, day, renewal, type Words } from '@/lib/certs-jobs';
import { useClustersStore } from '@/stores/clusters';

// A certificate's page (0.10, ADR-222, ADR-224): its facts, every place it is served, how it
// renews (and the job that does it), and every certificate seen under its names.
const { t } = useI18n();
const route = useRoute();
const clusters = useClustersStore();
const certId = computed(() => String(route.params.certId));
const node = computed(() => (typeof route.query.node === 'string' ? route.query.node : ''));

const page = useLoader(async () => {
  await clusters.ensure();
  const c = clusters.selected;
  if (!c) return null;
  try {
    const q = node.value ? `?node=${encodeURIComponent(node.value)}` : '';
    return await api<CertificateDetail>(`/clusters/${c.id}/certificates/${certId.value}${q}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
});
onMounted(() => void page.load());
watch([certId, node, () => clusters.selected?.id], () => void page.load());

const c = computed(() => page.data.value?.certificate ?? null);
const say = (w: Words) => t(w.key, w.values ?? {}, Number(w.values?.n ?? 1));
const where = (e: NonNullable<typeof c.value>['endpoints'][number]) =>
  e.kind === 'Ingress'
    ? `Ingress ${e.workload}`
    : `${e.kind === 'Service' && !c.value?.node ? 'Service ' : ''}${e.workload}`;
</script>

<template>
  <div class="flex flex-col gap-5" data-testid="certificate">
    <RouterLink
      :to="{ name: 'certificates' }"
      class="inline-flex min-h-11 w-fit items-center gap-1.5 text-14 text-text-muted hover:text-text"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />{{ $t('certs.detail.back') }}
    </RouterLink>

    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('certs.error')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <SkeletonDetailHeader v-if="page.skeleton.value" :label="$t('common.loading')" />
    <EmptyState
      v-else-if="page.loaded.value && !c"
      :icon="ShieldAlert"
      :title="$t('certs.detail.notFound')"
      description=""
    />

    <template v-else-if="c">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
          <h1 class="font-mono text-24 font-semibold break-all text-text">{{ c.names[0] }}</h1>
          <p
            :class="[
              'text-15 font-semibold',
              CERT_TONE[c.status] === 'crit'
                ? 'text-critical'
                : c.status === 'expiring'
                  ? 'text-warning'
                  : 'text-text-muted',
            ]"
          >
            {{ say(certDays(c)) }} · {{ day(c.notAfter) }}
          </p>
        </div>
        <ToneChip :tone="CERT_TONE[c.status]" :label="$t(`certs.status.${c.status}`)" />
      </header>

      <ul v-if="certProblems(c).length" class="flex flex-col gap-1.5" data-testid="problems">
        <li
          v-for="p in certProblems(c)"
          :key="p.key"
          class="rounded-card border border-warning/40 bg-warning/10 px-4 py-2.5 text-14 text-text"
        >
          {{ say(p) }}
        </li>
      </ul>

      <div class="grid gap-4 lg:grid-cols-2">
        <section class="rounded-card border border-border bg-surface-1 p-4">
          <h2 class="mb-3 text-15 font-semibold text-text">{{ $t('certs.detail.facts') }}</h2>
          <dl class="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-14">
            <dt class="text-text-muted">{{ $t('certs.detail.names') }}</dt>
            <dd class="font-mono break-all text-text">{{ c.names.join(', ') }}</dd>
            <dt class="text-text-muted">{{ $t('certs.detail.issuer') }}</dt>
            <dd class="text-text">{{ c.issuerOrg ? `${c.issuerOrg} (${c.issuer})` : c.issuer }}</dd>
            <dt class="text-text-muted">{{ $t('certs.detail.validFrom') }}</dt>
            <dd class="text-text">{{ day(c.notBefore) }}</dd>
            <dt class="text-text-muted">{{ $t('certs.detail.validUntil') }}</dt>
            <dd class="text-text">{{ day(c.notAfter) }}</dd>
            <dt class="text-text-muted">{{ $t('certs.detail.key') }}</dt>
            <dd class="text-text">{{ c.keyType }} {{ c.keyBits }}</dd>
            <dt class="text-text-muted">{{ $t('certs.detail.chain') }}</dt>
            <dd :class="c.chain === 'incomplete' ? 'text-warning' : 'text-text'">
              {{ $t(`certs.chain.${c.chain}`) }}
            </dd>
            <dt class="text-text-muted">{{ $t('certs.detail.fingerprint') }}</dt>
            <dd class="font-mono text-12 break-all text-text-muted">{{ c.fingerprint }}</dd>
          </dl>
        </section>

        <div class="flex flex-col gap-4">
          <section class="rounded-card border border-border bg-surface-1 p-4">
            <h2 class="mb-3 text-15 font-semibold text-text">{{ $t('certs.detail.served') }}</h2>
            <ul class="flex flex-col gap-2" data-testid="endpoints">
              <li
                v-for="e in c.endpoints"
                :key="`${e.kind}/${e.workload}/${e.port}/${e.sni}`"
                class="flex flex-wrap items-baseline gap-x-2 text-14"
              >
                <span class="font-mono text-text">{{ where(e) }}</span>
                <span v-if="c.node" class="text-text-muted">· {{ c.node }}</span>
                <span class="text-text-muted"
                  >· {{ $t('certs.detail.port', { port: e.port }) }}</span
                >
                <span v-if="e.sni" class="text-text-muted"
                  >· {{ $t('certs.detail.sni', { name: e.sni }) }}</span
                >
              </li>
            </ul>
          </section>
          <section class="rounded-card border border-border bg-surface-1 p-4">
            <h2 class="mb-2 text-15 font-semibold text-text">{{ $t('certs.detail.renewal') }}</h2>
            <p
              :class="[
                'text-14',
                renewal(c).tone === 'crit'
                  ? 'text-critical'
                  : renewal(c).tone === 'warn'
                    ? 'text-warning'
                    : 'text-text-muted',
              ]"
            >
              {{ say(renewal(c).words) }}
            </p>
            <p v-if="c.renewalJob" class="mt-2 text-14">
              <span class="text-text-muted">{{ $t('certs.detail.renewalJob') }}:</span>
              <RouterLink
                :to="{
                  name: 'scheduled-job',
                  params: { jobId: c.renewalJob.id },
                  query: c.node ? { node: c.node } : {},
                }"
                class="ml-1 font-mono text-primary hover:underline"
                >{{ c.renewalJob.name }}</RouterLink
              >
              <span class="text-text-muted"> · {{ $t(`jobs.status.${c.renewalJob.state}`) }}</span>
            </p>
          </section>
        </div>
      </div>

      <section class="rounded-card border border-border bg-surface-1 p-4">
        <h2 class="mb-3 text-15 font-semibold text-text">{{ $t('certs.detail.history') }}</h2>
        <ol class="flex flex-col gap-3" data-testid="history">
          <li
            v-for="h in page.data.value!.history"
            :key="h.fingerprint"
            class="flex flex-col gap-0.5 border-l-2 pl-3 text-14"
            :class="h.current ? 'border-primary' : 'border-border'"
          >
            <span class="text-text">
              {{ day(h.notBefore) }} – {{ day(h.notAfter) }} · {{ h.issuer }}
              <span v-if="h.current" class="ml-1 text-12 font-semibold text-ok">{{
                $t('certs.detail.current')
              }}</span>
            </span>
            <span class="text-13 text-text-muted">
              {{ $t('certs.detail.seen', { from: day(h.firstSeen), to: day(h.lastSeen) }) }}
              <template v-if="h.renewedDaysBefore !== null">
                ·
                {{
                  $t('certs.detail.renewedBefore', { n: Math.round(h.renewedDaysBefore) })
                }}</template
              >
            </span>
            <span class="font-mono text-12 break-all text-text-subtle"
              >{{ h.fingerprint.slice(0, 32) }}…</span
            >
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>
