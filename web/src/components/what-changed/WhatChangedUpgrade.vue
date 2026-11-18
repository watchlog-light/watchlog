<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Lock } from '@lucide/vue';
import type { Alert, AlertList, Cluster } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import { cloudApi, leaveFor, problemCode, type BillingState } from '@/api/cloud';
import Skeleton from '@/components/ui/Skeleton.vue';
import { rememberCheckoutOrigin } from '@/lib/checkout-return';
import { LINKS } from '@/lib/links';
import { readyIfStartedAt, readyParts } from '@/lib/what-changed-learning';
import {
  alertWhen,
  demoExample,
  lastAlerts,
  money,
  upgradeAction,
} from '@/lib/what-changed-upgrade';
import { useAuthStore } from '@/stores/auth';
import { usePlanStore } from '@/stores/plan';
import LearningBrain from './LearningBrain.vue';
import LearningWeekGrid from './LearningWeekGrid.vue';
import WhatChangedChart from './WhatChangedChart.vue';
import WhatChangedRows from './WhatChangedRows.vue';

// The upgrade page (ADR-201, the screen Locked; its hero ADR-216): what Cloud Free and
// Community see in place of What changed. The hero is the learning page's own centrepiece in
// its "waiting" state: the brain dim and calm, the ring and the week's grid empty, labelled
// "Not learning yet", because for a Free org nothing is learned (ADR-195) and the page never
// suggests otherwise. Beside it: when it would be ready if the org upgraded today (Cloud
// Free: today plus 7 days, in the viewer's time zone; Community gets no date it can't keep),
// Pro's price from the plans config, and the button: Checkout for a Free Owner while billing
// is live, Settings › Plan & billing while it is off, "Ask an Owner" for everyone else, and
// "Try WatchLog Cloud" for Community. Hovering or focusing Upgrade previews day 1 on the
// ring (not with reduced motion). Then the live demo's example (static, labelled), the org's
// own last alerts in this cluster or fleet, and the three reasons. Nothing here calls Cloud
// from a self-hosted install.
const props = defineProps<{
  access: 'free' | 'community';
  cluster: Cluster;
  /** Back from Stripe Checkout (ADR-216): the page turns into the learning page once Pro is on. */
  checkoutReturn?: 'done' | 'cancelled' | null;
  /** The clock (tests). */
  now?: number;
}>();
const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const plan = usePlanStore();

const free = computed(() => props.access === 'free');
const platform = computed(() => (props.cluster.kind === 'server' ? 'docker' : 'kubernetes'));
const example = computed(() => demoExample(platform.value));
const demoUrl = computed(
  () => `${(auth.cloud?.sampleUrl ?? 'https://demo.watchlog.io').replace(/\/$/, '')}/what-changed`,
);

const billing = ref<BillingState | null>(null);
const action = computed(() => upgradeAction(props.access, auth.user?.role, billing.value));
const price = computed(() => {
  const p = plan.info?.price;
  if (!free.value || !p) return null;
  return {
    perNode: money(p.perNodeMonth, p.currency),
    minimum: money(p.minimumMonth, p.currency),
  };
});
const live = computed(() => !!(billing.value?.available && billing.value.live));

// "Upgrade today and it's ready on <date>": when the worker would be ready if it started
// now and nothing interrupted it (7 days of data, ADR-217), in the viewer's time zone. The
// date moves with the clock, so it is always a promise Pro keeps.
const today = computed(() => props.now ?? Date.now());
const readyOn = computed(() => readyParts(readyIfStartedAt(today.value)).date);
// The Upgrade button hovered or focused: the ring previews day 1.
const preview = ref(false);

// The org's last alerts: the firing ones and the history, newest first.
const alerts = ref<Alert[] | null>(null);
const alertsError = ref(false);
async function loadAlerts() {
  const q = (view: string) =>
    `/alerts?view=${view}&clusterId=${encodeURIComponent(props.cluster.id)}&limit=5`;
  try {
    const [firing, history] = await Promise.all([
      api<AlertList>(q('firing')),
      api<AlertList>(q('history')),
    ]);
    alerts.value = lastAlerts(firing.alerts, history.alerts);
  } catch {
    alertsError.value = true;
    alerts.value = [];
  }
}

// Who can upgrade, for an Admin or a Viewer.
const owners = ref<string[] | null>(null);
async function loadOwners() {
  try {
    const r = await api<{ users: { name: string | null; email: string; role: string }[] }>(
      '/users',
    );
    owners.value = r.users.filter((u) => u.role === 'owner').map((u) => u.name || u.email);
  } catch {
    owners.value = [];
  }
}

const busy = ref(false);
const error = ref<string | null>(null);
const planPage = { name: 'settings', query: { tab: 'billing' } };
async function startCheckout() {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const { url } = await cloudApi.checkout('monthly');
    // Checkout returns to Plan & billing; from there the browser comes back here.
    rememberCheckoutOrigin(props.cluster.id);
    leaveFor(url);
  } catch (err) {
    // Billing went off since the page asked: the beta switch is on Plan & billing.
    if (problemCode(err) === 'billing-not-live') await router.push(planPage);
    else error.value = t('whatChanged.upgrade.checkoutError');
  }
  busy.value = false;
}

onMounted(() => {
  void loadAlerts();
  if (!free.value) return;
  if (!plan.info) void plan.load();
  if (auth.user?.role === 'owner') {
    void cloudApi
      .billing()
      .then((b) => (billing.value = b))
      .catch(() => (billing.value = null));
  } else {
    void loadOwners();
  }
});
</script>

<template>
  <div class="flex flex-col gap-10 max-md:gap-7" data-testid="wc-upgrade" :data-access="access">
    <!-- The hero: the learning page's centrepiece, waiting. -->
    <section
      class="flex flex-wrap items-center gap-10 rounded-2xl border border-border bg-surface-1/45 p-9 max-md:gap-6 max-md:p-5"
      aria-labelledby="wc-up-title"
      data-testid="wc-up-hero"
    >
      <div class="mx-auto w-full max-w-[340px] min-w-[220px] flex-[0_1_340px] max-md:max-w-[260px]">
        <LearningBrain state="waiting" :start="today" :preview="preview" />
      </div>
      <div class="flex min-w-0 flex-[1_1_26rem] flex-col gap-4.5 max-md:gap-3.5">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span
            class="font-mono text-12 tracking-widest text-text-muted uppercase md:text-13"
            data-testid="wc-up-state"
            >{{ $t('whatChanged.upgrade.hero.label') }}</span
          >
          <span
            class="rounded-full border border-info/45 px-3 py-1 font-mono text-12 tracking-widest text-info uppercase"
            data-testid="wc-up-badge"
            >{{
              free
                ? price
                  ? $t('whatChanged.upgrade.badge.free', { perNode: price.perNode })
                  : $t('whatChanged.upgrade.badge.freeNoPrice')
                : $t('whatChanged.upgrade.badge.community')
            }}</span
          >
        </div>
        <h2
          id="wc-up-title"
          class="text-24 leading-tight font-semibold tracking-tight text-text md:text-32"
        >
          {{ $t('whatChanged.upgrade.hero.title') }}
          <span class="text-text-muted">{{
            $t(free ? 'whatChanged.upgrade.hero.titleFree' : 'whatChanged.upgrade.hero.titleCloud')
          }}</span>
        </h2>
        <p class="text-16 leading-relaxed text-text-muted" data-testid="wc-up-ready">
          {{
            free
              ? $t('whatChanged.upgrade.hero.ready', { date: readyOn })
              : $t(`whatChanged.upgrade.hero.community.${platform}`, { cluster: cluster.name })
          }}
        </p>
        <p
          v-if="checkoutReturn"
          class="rounded-control border border-border bg-surface-2 px-3 py-2.5 text-14 text-text"
          role="status"
          data-testid="wc-up-checkout-return"
        >
          {{
            checkoutReturn === 'done'
              ? $t('whatChanged.upgrade.hero.checkoutDone')
              : $t('cloud.plan.billing.checkoutCancelled')
          }}
        </p>
        <div class="flex flex-wrap gap-3 pt-1" data-testid="wc-up-actions">
          <template v-if="action === 'ask-owner'">
            <span class="wc-cta wc-cta-off" data-testid="wc-up-ask">{{
              $t('whatChanged.upgrade.askOwner')
            }}</span>
          </template>
          <button
            v-else-if="action === 'checkout'"
            type="button"
            class="wc-cta"
            :aria-busy="busy"
            :disabled="busy"
            data-testid="wc-up-checkout"
            @click="startCheckout"
            @mouseenter="preview = true"
            @mouseleave="preview = false"
            @focus="preview = true"
            @blur="preview = false"
          >
            {{ $t('whatChanged.upgrade.cta.free') }}
          </button>
          <RouterLink
            v-else-if="action === 'plan'"
            :to="planPage"
            class="wc-cta"
            data-testid="wc-up-plan"
            @mouseenter="preview = true"
            @mouseleave="preview = false"
            @focus="preview = true"
            @blur="preview = false"
            >{{ $t('whatChanged.upgrade.cta.free') }}</RouterLink
          >
          <a
            v-else
            :href="LINKS.cloudSignup"
            target="_blank"
            rel="noopener"
            class="wc-cta"
            data-testid="wc-up-cloud"
            >{{ $t('whatChanged.upgrade.cta.community')
            }}<span class="sr-only"> {{ $t('whatChanged.upgrade.cta.newTab') }}</span></a
          >
          <a
            :href="demoUrl"
            target="_blank"
            rel="noopener"
            class="wc-ghost-cta"
            data-testid="wc-up-demo"
            >{{ $t('whatChanged.upgrade.cta.demo')
            }}<span class="sr-only"> {{ $t('whatChanged.upgrade.cta.newTab') }}</span></a
          >
        </div>
        <p v-if="action === 'ask-owner'" class="text-14 text-text-muted" data-testid="wc-up-owners">
          {{
            owners && owners.length
              ? $t('whatChanged.upgrade.owners', { names: owners.join(', ') })
              : $t('whatChanged.upgrade.ownersUnknown')
          }}
        </p>
        <p v-if="error" class="text-14 text-critical" role="alert" data-testid="wc-up-error">
          {{ error }}
        </p>
        <p class="text-14 text-text-subtle" data-testid="wc-up-fine">
          <template v-if="free">
            <template v-if="price">{{
              $t(`whatChanged.upgrade.fine.${platform}`, price)
            }}</template>
            <template v-if="live">{{ ' ' + $t('whatChanged.upgrade.fine.stripe') }}</template>
          </template>
          <template v-else>{{ $t('whatChanged.upgrade.fine.community') }}</template>
        </p>
      </div>
    </section>

    <!-- The week it will learn: every hour "not seen yet". -->
    <LearningWeekGrid week="" :now="today" waiting />

    <!-- The live demo's example: static, labelled, never another org's data. -->
    <section
      class="wc-glow flex flex-col gap-5 rounded-2xl border border-border bg-surface-1/45 p-7 max-md:gap-4 max-md:p-4"
      aria-labelledby="wc-up-demo-title"
      data-testid="wc-up-example"
    >
      <div
        class="flex flex-wrap justify-between gap-x-4 gap-y-1 font-mono text-12 tracking-widest uppercase md:text-13"
      >
        <h3 id="wc-up-demo-title" class="text-text">{{ $t('whatChanged.upgrade.demo.title') }}</h3>
        <span class="text-text-subtle" data-testid="wc-up-demo-label">{{
          $t(
            platform === 'docker'
              ? 'whatChanged.upgrade.demo.labelDocker'
              : 'whatChanged.upgrade.demo.label',
          )
        }}</span>
      </div>
      <WhatChangedChart :answer="example.chart" />
      <WhatChangedRows :rows="example.rows" />
      <div
        class="wc-cause-ok flex gap-5 rounded-xl border border-ok/40 px-5 py-4.5 max-md:gap-4 max-md:px-4"
      >
        <span class="w-[3px] shrink-0 rounded-sm bg-ok" aria-hidden="true" />
        <div class="flex min-w-0 flex-col gap-1.5">
          <span class="font-mono text-12 tracking-widest text-ok uppercase">{{
            $t('whatChanged.cause.label.likely')
          }}</span>
          <span class="text-16 leading-snug font-medium text-text md:text-20">{{
            $t(`whatChanged.upgrade.demo.cause.${platform}`)
          }}</span>
        </div>
      </div>
    </section>

    <!-- The org's own last alerts. -->
    <section
      class="flex flex-col gap-4.5 rounded-2xl border border-border bg-surface-1/45 p-7 max-md:gap-3.5 max-md:p-4"
      aria-labelledby="wc-up-alerts-title"
      data-testid="wc-up-alerts"
    >
      <div
        class="flex flex-wrap justify-between gap-x-4 gap-y-1 font-mono text-12 tracking-widest uppercase md:text-13"
      >
        <h3 id="wc-up-alerts-title" class="text-text">
          {{ $t('whatChanged.upgrade.alerts.title', { cluster: cluster.name }) }}
        </h3>
        <span class="text-text-subtle">{{
          free
            ? $t('whatChanged.upgrade.alerts.subFree')
            : $t('whatChanged.upgrade.alerts.subCommunity')
        }}</span>
      </div>
      <div v-if="alerts === null" class="flex flex-col gap-2" aria-busy="true">
        <Skeleton v-for="i in 2" :key="i" shape="rect" class="h-14 w-full" />
      </div>
      <p v-else-if="alertsError" class="text-14 text-text-muted" data-testid="wc-up-alerts-error">
        {{ $t('whatChanged.upgrade.alerts.error') }}
      </p>
      <p v-else-if="!alerts.length" class="text-14 text-text-muted" data-testid="wc-up-alerts-none">
        {{ $t(`whatChanged.upgrade.alerts.none.${platform}`, { cluster: cluster.name }) }}
      </p>
      <ol v-else class="flex flex-col gap-2" :aria-label="$t('whatChanged.upgrade.alerts.label')">
        <li v-for="a in alerts" :key="a.id">
          <RouterLink
            :to="{ name: 'alert', params: { id: a.id } }"
            class="group flex flex-wrap items-center gap-x-4.5 gap-y-1 rounded-card bg-surface-1 px-4.5 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary max-md:px-4"
            data-testid="wc-up-alert"
          >
            <span class="min-w-24 font-mono text-13 text-text-subtle tabular">{{
              alertWhen(a.startedAt)
            }}</span>
            <span
              class="min-w-0 flex-[1_1_18rem] text-14 break-words text-text group-hover:underline md:text-16"
              >{{ a.title }}</span
            >
            <span class="inline-flex items-center gap-2 text-14 text-info">
              <Lock class="size-3.5" aria-hidden="true" />
              {{
                free
                  ? $t('whatChanged.upgrade.alerts.lockedFree')
                  : $t('whatChanged.upgrade.alerts.lockedCommunity')
              }}
            </span>
          </RouterLink>
        </li>
      </ol>
    </section>

    <!-- The three reasons. -->
    <section
      class="grid grid-cols-1 gap-4 md:grid-cols-3"
      :aria-label="$t('whatChanged.upgrade.reasons.label')"
      data-testid="wc-up-reasons"
    >
      <div
        v-for="(r, i) in ['first', 'alerts', 'history'] as const"
        :key="r"
        class="flex flex-col gap-2.5 rounded-2xl border border-border bg-surface-1/45 p-6 max-md:p-4.5"
      >
        <span class="font-mono text-13 tracking-widest text-ok">0{{ i + 1 }}</span>
        <b class="text-16 font-semibold text-text md:text-20">{{
          $t(`whatChanged.upgrade.reasons.${r}.title`)
        }}</b>
        <span class="text-14 leading-relaxed text-text-muted">{{
          $t(`whatChanged.upgrade.reasons.${r}.${r === 'first' ? 'body' : platform}`)
        }}</span>
      </div>
    </section>

    <p class="border-t border-border pt-6 text-14 text-text-muted" data-testid="wc-up-free-note">
      {{ $t('whatChanged.upgrade.bottom.free_note') }}
    </p>
  </div>
</template>

<style scoped>
.wc-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding: 0 26px;
  border-radius: 10px;
  background: var(--primary);
  color: var(--on-primary);
  font-size: 16px;
  font-weight: 600;
}
.wc-cta:hover {
  background: var(--primary-hover);
}
.wc-cta:disabled {
  opacity: 0.7;
}
.wc-cta-off,
.wc-cta-off:hover {
  background: var(--surface-2);
  color: var(--text-muted);
  border: 1px solid var(--border);
}
.wc-ghost-cta {
  display: inline-flex;
  align-items: center;
  min-height: 48px;
  padding: 0 24px;
  border-radius: 10px;
  border: 1px solid var(--border-strong);
  color: var(--text);
  font-size: 16px;
}
.wc-ghost-cta:hover {
  background: var(--surface-2);
}
.wc-cta:focus-visible,
.wc-ghost-cta:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
/* The screen's soft green glow under the demo's example. */
.wc-glow {
  box-shadow: 0 30px 80px -40px color-mix(in srgb, var(--primary) 35%, transparent);
}
.wc-cause-ok {
  background: color-mix(in srgb, var(--ok) 4%, var(--bg));
}
</style>
