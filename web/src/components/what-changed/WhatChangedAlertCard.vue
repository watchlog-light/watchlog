<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowRight, CircleAlert, Hourglass, Lock } from '@lucide/vue';
import type { AlertDetail, WhatChanged } from '@watchlog/api-types';
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useLoader } from '@/composables/useLoader';
import {
  initialAccess,
  isProFeature,
  whatChangedPath,
  type WhatChangedAccess,
} from '@/lib/what-changed';
import { dayOf, LEARNING_DAYS, readyParts } from '@/lib/what-changed-learning';
import { useAuthStore } from '@/stores/auth';
import WhatChangedRows from './WhatChangedRows.vue';

// "What changed around it" on an alert's page (ADR-199, the screen Anomaly): the first three
// rows of the alert's window and a link to the page in alert mode. Cloud Free sees one locked
// line that opens the page, which is the upgrade page for it (ADR-201); Community sees
// nothing (ADR-195). During the learning week (ADR-216) it is one line with the day and when
// it is ready, opening the learning page, instead of an empty card.
const CARD_ROWS = 3;
const props = defineProps<{ alert: AlertDetail['alert'] }>();
const auth = useAuthStore();
const access = ref<WhatChangedAccess | null>(initialAccess(auth.isCloud, auth.demoMode));

const page = useLoader(async () => {
  try {
    const a = await api<WhatChanged>(
      whatChangedPath(props.alert.cluster.id, { window: 'alert', alert: props.alert.id }),
    );
    access.value = 'pro';
    return a;
  } catch (err) {
    if (isProFeature(err)) {
      access.value = 'free';
      return null;
    }
    throw err;
  }
});
const a = computed(() => page.data.value ?? null);
const rows = computed(() => a.value?.rows.slice(0, CARD_ROWS) ?? []);
const docker = computed(() => props.alert.cluster.kind === 'server');
const learning = computed(() => {
  const l = a.value?.learning;
  if (!l?.learning) return null;
  return {
    day: dayOf(l, Date.now()),
    days: LEARNING_DAYS,
    ready: l.until ? readyParts(Date.parse(l.until)) : null,
  };
});
const link = computed(() => ({
  name: 'what-changed',
  query: { cluster: props.alert.cluster.id, alert: props.alert.id },
}));

watch(
  () => props.alert.id,
  () => {
    if (access.value !== 'community') void page.load();
  },
);
onMounted(() => {
  if (access.value !== 'community') void page.load();
});
</script>

<template>
  <!-- Cloud Free: one line. -->
  <RouterLink
    v-if="access === 'free'"
    :to="{ name: 'what-changed', query: { cluster: alert.cluster.id } }"
    class="flex min-h-11 items-center gap-3 rounded-card border border-border bg-surface-1 px-4.5 py-3 text-13 text-text-muted hover:border-border-strong hover:text-text max-md:px-4"
    data-testid="wc-card-locked"
  >
    <Lock class="size-4 shrink-0 text-info" aria-hidden="true" />
    <span class="min-w-0 flex-1">{{ $t('whatChanged.card.locked') }}</span>
    <span class="font-semibold text-info">{{ $t('whatChanged.pro') }}</span>
  </RouterLink>

  <!-- The learning week: one line with the ready date. -->
  <RouterLink
    v-else-if="learning"
    :to="{ name: 'what-changed', query: { cluster: alert.cluster.id } }"
    class="flex min-h-11 items-center gap-3 rounded-card border border-border bg-surface-1 px-4.5 py-3 text-13 text-text-muted hover:border-border-strong hover:text-text max-md:px-4"
    data-testid="wc-card-learning"
  >
    <Hourglass class="size-4 shrink-0 text-info" aria-hidden="true" />
    <span class="min-w-0 flex-1">{{
      learning.ready
        ? $t('whatChanged.card.learning', {
            cluster: alert.cluster.name,
            day: learning.day,
            days: learning.days,
            ...learning.ready,
          })
        : $t('whatChanged.learning.starting', { cluster: alert.cluster.name })
    }}</span>
    <ArrowRight class="size-3.5 shrink-0" aria-hidden="true" />
  </RouterLink>

  <section
    v-else-if="access !== 'community'"
    class="flex flex-col gap-4 rounded-2xl border border-border bg-surface-1/45 p-5.5 max-md:p-4"
    aria-labelledby="wc-card-title"
    data-testid="wc-card"
  >
    <div
      class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-12 tracking-widest uppercase"
    >
      <h3 id="wc-card-title" class="font-medium text-text">{{ $t('whatChanged.card.title') }}</h3>
      <RouterLink
        v-if="a"
        :to="link"
        class="inline-flex min-h-6 items-center gap-1 text-text-subtle hover:text-text max-lg:min-h-11"
        data-testid="wc-card-link"
      >
        {{ $t('whatChanged.card.open', { n: a.total }, a.total) }}
        <ArrowRight class="size-3.5" aria-hidden="true" />
      </RouterLink>
    </div>

    <div v-if="!a && !page.error.value" class="flex flex-col gap-2" aria-busy="true">
      <Skeleton v-for="i in 3" :key="i" shape="rect" class="h-11 w-full" />
    </div>
    <div
      v-else-if="!a"
      class="flex flex-wrap items-center gap-3 text-13 text-text-muted"
      role="status"
      data-testid="wc-card-error"
    >
      <CircleAlert class="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
      <span class="min-w-0 flex-1">{{ $t('whatChanged.errors.load') }}</span>
      <button
        type="button"
        class="inline-flex h-8 items-center rounded-control border border-border-strong px-3 text-13 font-medium text-text hover:bg-surface-2 max-lg:min-h-11"
        @click="page.load"
      >
        {{ $t('common.retry') }}
      </button>
    </div>
    <template v-else-if="rows.length">
      <WhatChangedRows :rows="rows" compact :cluster-id="alert.cluster.id" />
      <RouterLink
        v-if="a.total > rows.length"
        :to="link"
        class="text-13 text-text-muted hover:text-text hover:underline"
        data-testid="wc-card-more"
        >{{ $t('whatChanged.more', { n: a.total - rows.length }) }}</RouterLink
      >
    </template>
    <p v-else class="text-14 text-text-muted" data-testid="wc-card-empty">
      {{ $t(`whatChanged.card.none.${docker ? 'docker' : 'kubernetes'}`) }}
    </p>
  </section>
</template>
