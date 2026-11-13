<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { usePlanStore } from '@/stores/plan';

// Settings › Plan & billing (ADR-177, Billing.dc.html), Cloud only: the plan, what the org
// uses against it, and how nodes are counted. Starting Pro (the beta switch) and Stripe's
// Checkout and portal come with the billing service (Cloud slice 5). The Phase 6 features
// say "coming to Pro" (ADR-173).
const { t } = useI18n();
const plan = usePlanStore();
onMounted(() => void plan.load());
const p = computed(() => plan.info);

const period = computed(() => {
  if (!p.value) return '';
  const from = new Date(p.value.period.from);
  const last = new Date(new Date(p.value.period.to).getTime() - 86_400_000);
  const month = from.toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' });
  return t('cloud.plan.billing.period', {
    from: from.getUTCDate(),
    to: last.getUTCDate(),
    month,
  });
});

interface Meter {
  id: string;
  label: string;
  value: string;
  share: number | null;
  note: string;
}
const limitOf = (n: number | null) => (n === null ? '∞' : String(n));
const share = (used: number, max: number | null) =>
  max === null || max === 0 ? null : Math.min(1, used / max);

const meters = computed<Meter[]>(() => {
  const x = p.value;
  if (!x) return [];
  const pro = x.plan !== 'free';
  return [
    {
      id: 'nodes',
      label: t('cloud.plan.billing.nodes'),
      value: x.limits.nodes === null ? String(x.period.p95) : `${x.period.p95} / ${x.limits.nodes}`,
      share: share(x.period.p95, x.limits.nodes),
      note: t('cloud.plan.billing.nodesNote', { now: x.usage.nodes, peak: x.period.peak }),
    },
    {
      id: 'clusters',
      label: t('cloud.plan.billing.clusters'),
      value: `${x.usage.clusters} / ${limitOf(x.limits.clusters)}`,
      share: share(x.usage.clusters, x.limits.clusters),
      note: pro ? t('cloud.plan.billing.unlimited') : t('cloud.plan.billing.proClusters'),
    },
    {
      id: 'users',
      label: t('cloud.plan.billing.users'),
      value: `${x.usage.users} / ${limitOf(x.limits.users)}`,
      share: share(x.usage.users, x.limits.users),
      note: pro ? t('cloud.plan.billing.countsInvites') : t('cloud.plan.billing.proUsers'),
    },
    {
      id: 'retention',
      label: t('cloud.plan.billing.retention'),
      value: t(
        'cloud.plan.billing.daysValue',
        { n: x.limits.retentionDays },
        x.limits.retentionDays,
      ),
      share: Math.min(1, x.limits.retentionDays / 30),
      note: pro ? t('cloud.plan.billing.retentionPro') : t('cloud.plan.billing.proRetention'),
    },
  ];
});

// The estimate (the screen's slider): $1 a node a month, $10 minimum (SPEC §3.2).
const estimateNodes = ref(12);
const monthly = computed(() => Math.max(10, estimateNodes.value));
</script>

<template>
  <div class="flex max-w-5xl flex-col gap-5" data-testid="plan-billing">
    <div
      class="rounded-card border border-info/35 bg-info/10 px-4 py-3.5 text-14 leading-relaxed text-text"
      data-testid="beta-notice"
    >
      <b>{{ $t('cloud.plan.billing.betaTitle') }}</b>
      {{ $t('cloud.plan.billing.betaBody') }}
    </div>

    <p v-if="plan.loaded && !p" class="text-14 text-text-muted">
      {{ $t('cloud.plan.billing.unavailable') }}
    </p>

    <section
      v-if="p"
      class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-4 md:p-5"
      aria-labelledby="plan-title"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="plan-title" class="text-16 font-semibold text-text">
          {{ $t('cloud.plan.billing.yourPlan', { plan: $t(`cloud.plan.short.${p.plan}`) }) }}
        </h2>
        <span class="text-13 text-text-muted">{{ period }}</span>
      </div>
      <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div
          v-for="m in meters"
          :key="m.id"
          class="flex min-w-0 flex-col gap-2"
          :data-testid="`meter-${m.id}`"
        >
          <span class="text-13 text-text-muted">{{ m.label }}</span>
          <span class="font-mono text-20 text-text">{{ m.value }}</span>
          <div v-if="m.share !== null" class="h-1.5 rounded-full bg-surface-3" aria-hidden="true">
            <div
              :class="[
                'h-1.5 rounded-full',
                m.share >= 1 && m.id !== 'retention' ? 'bg-warning' : 'bg-primary',
              ]"
              :style="{ width: `${Math.max(2, Math.round(m.share * 100))}%` }"
            />
          </div>
          <span class="text-12 text-text-muted">{{ m.note }}</span>
        </div>
      </div>
    </section>

    <div class="flex flex-wrap gap-5">
      <section
        class="flex min-w-0 flex-[1_1_380px] flex-col gap-4 rounded-card border border-primary bg-surface-1 p-4 md:p-5"
        aria-labelledby="pro-title"
        data-testid="pro-card"
      >
        <h2 id="pro-title" class="text-18 font-semibold text-text">
          {{ $t('cloud.plan.short.pro') }}
        </h2>
        <ul class="list-disc pl-4.5 text-14 leading-loose text-text-muted">
          <li>{{ $t('cloud.plan.billing.proLimits') }}</li>
          <li>{{ $t('cloud.plan.billing.proComing') }}</li>
          <li>{{ $t('cloud.plan.billing.proSupport') }}</li>
        </ul>
        <div class="flex flex-col gap-2 border-t border-border pt-4">
          <label for="estimate-nodes" class="flex justify-between text-14 text-text">
            <span>{{ $t('cloud.plan.billing.estimateFor') }}</span>
            <b class="font-mono">{{
              $t('cloud.plan.nodes', { n: estimateNodes }, estimateNodes)
            }}</b>
          </label>
          <input
            id="estimate-nodes"
            v-model.number="estimateNodes"
            type="range"
            min="1"
            max="100"
            class="h-7 w-full accent-primary"
          />
          <div class="flex flex-wrap items-baseline gap-2">
            <span class="text-28 font-bold text-text">{{
              $t('cloud.plan.billing.perMonth', { n: monthly })
            }}</span>
            <span class="text-14 text-text-muted">{{
              estimateNodes < 10
                ? $t('cloud.plan.billing.minimum')
                : $t('cloud.plan.billing.perNode')
            }}</span>
          </div>
        </div>
        <p class="text-13 leading-normal text-text-muted">
          {{ $t('cloud.plan.billing.startSoon') }}
        </p>
      </section>

      <div class="flex min-w-0 flex-[1_1_300px] flex-col gap-5">
        <section
          class="flex flex-col gap-2.5 rounded-card border border-border bg-surface-1 p-4 md:p-5"
          aria-labelledby="counted-title"
          data-testid="how-counted"
        >
          <h2 id="counted-title" class="text-16 font-semibold text-text">
            {{ $t('cloud.plan.billing.countedTitle') }}
          </h2>
          <p class="text-14 leading-relaxed text-text-muted">
            {{ $t('cloud.plan.billing.countedBody') }}
          </p>
          <p class="text-14 leading-relaxed text-text-muted">
            {{ $t('cloud.plan.billing.countedExample') }}
          </p>
          <p class="text-14 leading-relaxed text-text-muted">
            {{ $t('cloud.plan.billing.countedLimit') }}
          </p>
        </section>
        <section
          class="flex flex-col gap-2.5 rounded-card border border-border bg-surface-1 p-4 md:p-5"
          aria-labelledby="invoices-title"
        >
          <h2 id="invoices-title" class="text-16 font-semibold text-text">
            {{ $t('cloud.plan.billing.invoicesTitle') }}
          </h2>
          <p class="text-14 leading-relaxed text-text-muted">
            {{ $t('cloud.plan.billing.invoicesBody') }}
          </p>
          <span
            class="self-start rounded-control border border-border px-4 py-2.5 text-14 text-text-muted"
          >
            {{ $t('cloud.plan.billing.whenBilling') }}
          </span>
        </section>
      </div>
    </div>
  </div>
</template>
