<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import {
  cloudApi,
  cloudErrorKey,
  leaveFor,
  type BillingInterval,
  type BillingState,
} from '@/api/cloud';
import BaseButton from '@/components/ui/BaseButton.vue';
import { useAuthStore } from '@/stores/auth';
import { usePlanStore } from '@/stores/plan';

// Settings › Plan & billing (ADR-177, ADR-178, Billing.dc.html), Cloud only: the plan, what
// the org uses against it, the Pro card with the monthly/annual estimate, and how nodes are
// counted. While billing is off (the live switch), an Owner starts "Pro, free during beta";
// once it's live, Upgrade opens Stripe Checkout and Manage billing the Customer Portal, both
// through the product's routes to the billing service. The Phase 6 features say "coming to
// Pro" (ADR-173).
const { t } = useI18n();
const plan = usePlanStore();
const auth = useAuthStore();
const route = useRoute();
const billing = ref<BillingState | null>(null);
const busy = ref<'beta' | 'checkout' | 'portal' | null>(null);
const error = ref<string | null>(null);

async function loadBilling() {
  try {
    billing.value = await cloudApi.billing();
  } catch {
    billing.value = null;
  }
}
onMounted(() => {
  void plan.load();
  void loadBilling();
});
const p = computed(() => plan.info);
const isOwner = computed(() => auth.user?.role === 'owner');
const checkoutReturn = computed(() => {
  const c = route.query.checkout;
  return c === 'done' || c === 'cancelled' ? c : null;
});

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

// The estimate (the screen's slider): $1 a node a month, $10 minimum; annual is $10 a node
// a year for at least 10 nodes, two months free (SPEC §3.2, ADR-178).
const estimateNodes = ref(12);
const interval = ref<BillingInterval>('monthly');
const billed = computed(() => Math.max(10, estimateNodes.value));
const price = computed(() =>
  interval.value === 'annual'
    ? t('cloud.plan.billing.perYear', { n: billed.value * 10 })
    : t('cloud.plan.billing.perMonth', { n: billed.value }),
);
const priceNote = computed(() => {
  if (interval.value === 'annual') {
    return estimateNodes.value < 10
      ? t('cloud.plan.billing.annualMinimum')
      : t('cloud.plan.billing.annualSaves', { n: billed.value * 2 });
  }
  return estimateNodes.value < 10
    ? t('cloud.plan.billing.minimum')
    : t('cloud.plan.billing.perNode');
});

const PAYING = ['active', 'trialing', 'past_due', 'unpaid'];
const subscribed = computed(() => {
  const s = billing.value?.subscription;
  return s && PAYING.includes(s.status) ? s : null;
});
const onBeta = computed(() => p.value?.plan === 'pro' && p.value.source === 'beta');
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

/**
 * What the Pro card offers: the beta's button while billing is off and the org is on Free,
 * Upgrade (Checkout) once it's live and the org has no subscription, else the plan's state.
 */
const action = computed<'beta' | 'upgrade' | 'onBeta' | 'subscribed' | 'unavailable' | null>(() => {
  const b = billing.value;
  if (!p.value || !b) return null;
  if (!b.available) return p.value.plan === 'free' ? 'unavailable' : null;
  if (subscribed.value) return 'subscribed';
  if (b.live) return p.value.plan === 'enterprise' ? null : 'upgrade';
  if (onBeta.value) return 'onBeta';
  return p.value.plan === 'free' ? 'beta' : null;
});

async function run(kind: 'beta' | 'checkout' | 'portal') {
  if (busy.value) return;
  busy.value = kind;
  error.value = null;
  try {
    if (kind === 'beta') {
      billing.value = await cloudApi.startBeta();
      await plan.load();
    } else {
      const { url } =
        kind === 'checkout'
          ? await cloudApi.checkout(
              interval.value,
              interval.value === 'annual' ? billed.value : undefined,
            )
          : await cloudApi.portal();
      leaveFor(url);
    }
  } catch (err) {
    error.value = t(cloudErrorKey(err));
  }
  busy.value = null;
}
</script>

<template>
  <div class="flex max-w-5xl flex-col gap-5" data-testid="plan-billing">
    <div
      v-if="!billing?.live"
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
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 id="pro-title" class="text-20 font-semibold text-text">
            {{ $t('cloud.plan.short.pro') }}
          </h2>
          <div
            class="inline-flex rounded-control border border-border bg-bg p-0.5"
            role="group"
            :aria-label="$t('cloud.plan.billing.interval')"
            data-testid="interval"
          >
            <button
              v-for="i in ['monthly', 'annual'] as const"
              :key="i"
              type="button"
              :aria-pressed="interval === i"
              :class="[
                'rounded-[4px] px-3 py-2 text-13 max-lg:min-h-11',
                interval === i ? 'bg-surface-3 font-semibold text-text' : 'text-text-muted',
              ]"
              :data-testid="`interval-${i}`"
              @click="interval = i"
            >
              {{ $t(`cloud.plan.billing.${i}`) }}
            </button>
          </div>
        </div>
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
          <div class="flex flex-wrap items-baseline gap-2" data-testid="estimate">
            <span class="text-32 font-bold text-text">{{ price }}</span>
            <span class="text-14 text-text-muted">{{ priceNote }}</span>
          </div>
        </div>

        <p
          v-if="checkoutReturn"
          class="rounded-control border border-border bg-surface-2 px-3 py-2.5 text-13 text-text"
          role="status"
          data-testid="checkout-return"
        >
          {{
            checkoutReturn === 'done'
              ? $t('cloud.plan.billing.checkoutDone')
              : $t('cloud.plan.billing.checkoutCancelled')
          }}
        </p>
        <p
          v-if="billing?.dunning && !billing.dunning.downgraded"
          class="rounded-control border border-warning/40 bg-warning/10 px-3 py-2.5 text-13 text-text"
          role="alert"
          data-testid="payment-failed"
        >
          {{
            $t('cloud.plan.billing.paymentFailed', { date: fmtDate(billing.dunning.downgradeAt) })
          }}
        </p>

        <div class="flex flex-col gap-2.5" data-testid="pro-action">
          <template v-if="action === 'beta' || action === 'upgrade'">
            <p
              v-if="action === 'upgrade' && onBeta && p?.betaUntil"
              class="text-14 font-semibold text-text"
            >
              {{ $t('cloud.plan.billing.onBetaUntil', { date: fmtDate(p.betaUntil) }) }}
            </p>
            <BaseButton
              block
              :loading="busy === (action === 'beta' ? 'beta' : 'checkout')"
              :disabled="!isOwner"
              :data-testid="action === 'beta' ? 'start-beta' : 'upgrade'"
              @click="run(action === 'beta' ? 'beta' : 'checkout')"
            >
              {{
                action === 'beta'
                  ? $t('cloud.plan.billing.startBeta')
                  : $t('cloud.plan.billing.upgrade')
              }}
            </BaseButton>
            <p v-if="!isOwner" class="text-13 text-text-muted" data-testid="owner-only">
              {{ $t('cloud.plan.billing.ownerOnly') }}
            </p>
            <p class="text-13 leading-normal text-text-muted">
              {{
                action === 'beta'
                  ? $t('cloud.plan.billing.startBetaNote')
                  : interval === 'annual'
                    ? `${$t('cloud.plan.billing.annualCommit', { n: billed })} ${$t('cloud.plan.billing.upgradeNote')}`
                    : $t('cloud.plan.billing.upgradeNote')
              }}
            </p>
          </template>
          <template v-else-if="action === 'onBeta'">
            <p class="text-14 font-semibold text-text" data-testid="on-beta">
              {{
                p?.betaUntil
                  ? $t('cloud.plan.billing.onBetaUntil', { date: fmtDate(p.betaUntil) })
                  : $t('cloud.plan.billing.onBeta')
              }}
            </p>
            <p class="text-13 leading-normal text-text-muted">
              {{
                p?.betaUntil
                  ? $t('cloud.plan.billing.onBetaUntilNote', { date: fmtDate(p.betaUntil) })
                  : $t('cloud.plan.billing.onBetaNote')
              }}
            </p>
          </template>
          <template v-else-if="action === 'subscribed' && subscribed">
            <p class="text-14 font-semibold text-text" data-testid="subscribed">
              {{
                $t('cloud.plan.billing.subscribed', {
                  interval: $t(`cloud.plan.billing.intervalWord.${subscribed.interval}`),
                })
              }}
            </p>
            <p v-if="subscribed.committedNodes" class="text-13 text-text-muted">
              {{ $t('cloud.plan.billing.committed', { n: subscribed.committedNodes }) }}
            </p>
            <p
              v-if="subscribed.cancelAtPeriodEnd && subscribed.currentPeriodEnd"
              class="text-13 text-text-muted"
            >
              {{
                $t('cloud.plan.billing.cancelling', { date: fmtDate(subscribed.currentPeriodEnd) })
              }}
            </p>
          </template>
          <p
            v-else-if="action === 'unavailable'"
            class="text-13 text-text-muted"
            data-testid="billing-unavailable"
          >
            {{ $t('cloud.plan.billing.unavailableNow') }}
          </p>
          <p v-if="error" class="text-13 text-critical" role="alert" data-testid="billing-error">
            {{ error }}
          </p>
        </div>
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
          <BaseButton
            v-if="billing?.available && billing.live && billing.customer"
            variant="secondary"
            class="self-start"
            :disabled="!isOwner"
            :loading="busy === 'portal'"
            data-testid="manage-billing"
            @click="run('portal')"
          >
            {{ $t('cloud.plan.billing.manage') }}
          </BaseButton>
          <span
            v-else
            class="self-start rounded-control border border-border px-4 py-2.5 text-14 text-text-muted"
            data-testid="invoices-later"
          >
            {{
              billing?.available && billing.live
                ? $t('cloud.plan.billing.afterUpgrade')
                : $t('cloud.plan.billing.whenBilling')
            }}
          </span>
        </section>
      </div>
    </div>
  </div>
</template>
