<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import { cloudApi, leaveFor, problemCode, type BillingState } from '@/api/cloud';
import { money, upgradeAction } from '@/lib/what-changed-upgrade';
import { useAuthStore } from '@/stores/auth';
import { usePlanStore } from '@/stores/plan';

// The card over the example page (ADR-226, the design's Upgrade board), in ADR-201's pattern:
// Cloud Free gets "Upgrade to Pro" with Pro's price from the plans config (Checkout for an
// Owner while billing is live, Plan & billing otherwise, "Ask an Owner" for everyone else);
// Community gets "Try WatchLog Cloud" and the live demo, and asks nothing of Cloud.
const props = defineProps<{ access: 'free' | 'community' }>();
const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const plan = usePlanStore();

const free = computed(() => props.access === 'free');
const billing = ref<BillingState | null>(null);
const action = computed(() => upgradeAction(props.access, auth.user?.role, billing.value));
const price = computed(() => {
  const p = plan.info?.price;
  return free.value && p
    ? { perNode: money(p.perNodeMonth, p.currency), minimum: money(p.minimumMonth, p.currency) }
    : null;
});
const demoUrl = computed(
  () => `${(auth.cloud?.sampleUrl ?? 'https://demo.watchlog.io').replace(/\/$/, '')}/all`,
);
const owners = ref<string[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);
const planPage = { name: 'settings', query: { tab: 'billing' } };

async function startCheckout() {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const { url } = await cloudApi.checkout('monthly');
    leaveFor(url);
  } catch (err) {
    if (problemCode(err) === 'billing-not-live') await router.push(planPage);
    else error.value = t('allClusters.upgrade.checkoutError');
  }
  busy.value = false;
}

onMounted(() => {
  if (!free.value) return;
  if (!plan.info) void plan.load();
  if (auth.user?.role === 'owner') {
    void cloudApi
      .billing()
      .then((b) => (billing.value = b))
      .catch(() => (billing.value = null));
  } else {
    void api<{ users: { name: string | null; email: string; role: string }[] }>('/users')
      .then(
        (r) =>
          (owners.value = r.users.filter((u) => u.role === 'owner').map((u) => u.name || u.email)),
      )
      .catch(() => (owners.value = []));
  }
});
</script>

<template>
  <section
    aria-labelledby="ac-up-title"
    class="flex w-full max-w-[560px] flex-col gap-4 rounded-[14px] border border-primary-border bg-surface-1 p-7 shadow-2xl max-sm:p-5"
    data-testid="ac-upgrade"
  >
    <span
      class="inline-flex h-5 w-fit items-center rounded-full border border-info/50 px-2 text-12 font-semibold text-info-text"
      >{{ $t('allClusters.upgrade.label') }}</span
    >
    <h2 id="ac-up-title" class="text-24 leading-tight font-semibold text-text max-sm:text-20">
      {{ $t('allClusters.upgrade.title') }}
    </h2>
    <p class="text-16 text-text-muted">
      {{ free ? $t('allClusters.upgrade.lead') : $t('allClusters.upgrade.leadCommunity') }}
    </p>
    <ul class="flex flex-col gap-2.5 text-14 text-text">
      <li v-for="n in 4" :key="n" class="flex gap-2.5">
        <span class="text-ok-text" aria-hidden="true">✓</span>
        <span>{{ $t(`allClusters.upgrade.point${n}`) }}</span>
      </li>
    </ul>
    <div class="flex flex-wrap items-center gap-3" data-testid="ac-up-actions">
      <template v-if="action === 'cloud'">
        <a
          href="https://cloud.watchlog.io/signup"
          class="inline-flex min-h-11 items-center rounded-control bg-primary px-4 text-16 font-semibold text-on-primary hover:bg-primary-hover"
          data-testid="ac-up-cloud"
          >{{ $t('allClusters.upgrade.tryCloud') }}</a
        >
        <a
          :href="demoUrl"
          target="_blank"
          rel="noopener"
          class="inline-flex min-h-11 items-center rounded-control border border-border px-4 text-16 font-semibold text-text hover:bg-surface-2"
          data-testid="ac-up-demo"
          >{{ $t('allClusters.upgrade.demo') }}</a
        >
      </template>
      <template v-else-if="action === 'ask-owner'">
        <span
          class="inline-flex min-h-11 items-center rounded-control border border-border px-4 text-16 text-text-muted"
          data-testid="ac-up-ask"
          >{{ $t('allClusters.upgrade.askOwner') }}</span
        >
      </template>
      <button
        v-else-if="action === 'checkout'"
        type="button"
        :disabled="busy"
        class="inline-flex min-h-11 items-center rounded-control bg-primary px-4 text-16 font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-60"
        data-testid="ac-up-checkout"
        @click="startCheckout"
      >
        {{ $t('allClusters.upgrade.upgrade') }}
      </button>
      <RouterLink
        v-else
        :to="planPage"
        class="inline-flex min-h-11 items-center rounded-control bg-primary px-4 text-16 font-semibold text-on-primary hover:bg-primary-hover"
        data-testid="ac-up-plan"
        >{{ $t('allClusters.upgrade.upgrade') }}</RouterLink
      >
      <span v-if="price" class="text-13 text-text-muted" data-testid="ac-up-price">{{
        $t('allClusters.upgrade.price', price)
      }}</span>
    </div>
    <p v-if="action === 'ask-owner' && owners.length" class="text-13 text-text-muted">
      {{ $t('allClusters.upgrade.owners', { names: owners.join(', ') }) }}
    </p>
    <p v-if="!free" class="text-13 text-text-muted">{{ $t('allClusters.upgrade.keeps') }}</p>
    <p v-if="error" class="text-13 text-critical-text" role="alert">{{ error }}</p>
    <span class="text-12 text-text-subtle">{{ $t('allClusters.upgrade.example') }}</span>
  </section>
</template>
