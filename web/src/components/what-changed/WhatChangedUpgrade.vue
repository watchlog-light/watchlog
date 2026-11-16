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
import { LINKS } from '@/lib/links';
import {
  alertWhen,
  demoExample,
  lastAlerts,
  money,
  upgradeAction,
} from '@/lib/what-changed-upgrade';
import { useAuthStore } from '@/stores/auth';
import { usePlanStore } from '@/stores/plan';
import WhatChangedChart from './WhatChangedChart.vue';
import WhatChangedRows from './WhatChangedRows.vue';

// The upgrade page (ADR-201, the screen Locked): what Cloud Free and Community see in place of
// What changed. The live demo's example (static, labelled), the org's own last alerts in this
// cluster or fleet (the alert list the install already serves), the three reasons, Pro's price
// from the plans config (Cloud Free), and the button: Checkout for a Free Owner while billing
// is live, Settings › Plan & billing while it is off, "Ask an Owner" for everyone else, and
// "Try WatchLog Cloud" for Community. Nothing here calls Cloud from a self-hosted install.
const props = defineProps<{ access: 'free' | 'community'; cluster: Cluster }>();
const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const plan = usePlanStore();

const free = computed(() => props.access === 'free');
const platform = computed(() => (props.cluster.kind === 'docker' ? 'docker' : 'kubernetes'));
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
async function checkout() {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const { url } = await cloudApi.checkout('monthly');
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
    <!-- The pitch and the button. -->
    <section
      class="mx-auto flex max-w-3xl flex-col items-center gap-5 pt-6 text-center max-md:gap-4 max-md:pt-2"
      aria-labelledby="wc-up-title"
    >
      <span
        class="rounded-full border border-info/45 px-3.5 py-1.5 font-mono text-12 tracking-widest text-info uppercase md:text-13"
        data-testid="wc-up-badge"
        >{{
          free
            ? price
              ? $t('whatChanged.upgrade.badge.free', { perNode: price.perNode })
              : $t('whatChanged.upgrade.badge.freeNoPrice')
            : $t('whatChanged.upgrade.badge.community')
        }}</span
      >
      <h2
        id="wc-up-title"
        class="text-32 leading-tight font-semibold tracking-tight text-text md:text-48"
      >
        {{ $t('whatChanged.upgrade.title') }}<br />
        <span class="text-text-muted">{{ $t('whatChanged.upgrade.titleMuted') }}</span>
      </h2>
      <p class="max-w-2xl text-16 leading-relaxed text-text-muted md:text-20">
        {{ $t(`whatChanged.upgrade.lead.${platform}`, { cluster: cluster.name }) }}
      </p>
      <div class="flex flex-wrap justify-center gap-3 pt-1.5" data-testid="wc-up-actions">
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
          @click="checkout"
        >
          {{ $t('whatChanged.upgrade.cta.free') }}
        </button>
        <RouterLink
          v-else-if="action === 'plan'"
          :to="planPage"
          class="wc-cta"
          data-testid="wc-up-plan"
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
          <template v-if="price">{{ $t(`whatChanged.upgrade.fine.${platform}`, price) }}</template>
          <template v-if="live">{{ ' ' + $t('whatChanged.upgrade.fine.stripe') }}</template>
        </template>
        <template v-else>{{ $t('whatChanged.upgrade.fine.community') }}</template>
      </p>
    </section>

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

    <section
      class="flex flex-wrap items-center justify-between gap-5 border-t border-border pt-8 max-md:pt-6"
    >
      <div class="flex flex-col gap-1.5">
        <span class="text-20 font-semibold text-text md:text-24">{{
          $t(`whatChanged.upgrade.bottom.${access}`, { cluster: cluster.name })
        }}</span>
        <span class="text-14 text-text-muted">{{
          $t('whatChanged.upgrade.bottom.free_note')
        }}</span>
      </div>
      <span v-if="action === 'ask-owner'" class="wc-cta wc-cta-off">{{
        $t('whatChanged.upgrade.askOwner')
      }}</span>
      <button
        v-else-if="action === 'checkout'"
        type="button"
        class="wc-cta"
        :disabled="busy"
        @click="checkout"
      >
        {{ $t('whatChanged.upgrade.cta.free') }}
      </button>
      <RouterLink v-else-if="action === 'plan'" :to="planPage" class="wc-cta">{{
        $t('whatChanged.upgrade.cta.free')
      }}</RouterLink>
      <a v-else :href="LINKS.cloudSignup" target="_blank" rel="noopener" class="wc-cta"
        >{{ $t('whatChanged.upgrade.cta.community')
        }}<span class="sr-only"> {{ $t('whatChanged.upgrade.cta.newTab') }}</span></a
      >
    </section>
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
