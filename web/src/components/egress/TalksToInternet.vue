<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleAlert, Globe } from '@lucide/vue';
import type { Egress, EgressRow } from '@watchlog/api-types';
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useLoader } from '@/composables/useLoader';
import {
  egressHistoryRange,
  egressPath,
  firstSeenText,
  percent,
  type EgressQuery,
} from '@/lib/egress';
import { useAuthStore } from '@/stores/auth';
import EgressBadges from './EgressBadges.vue';
import ExpectedActions from './ExpectedActions.vue';

// "Talks to the internet" on a source's page (ADR-188): the workload's, Compose service's or
// container's destinations over the last 30 days, each with since when, today's connections,
// the failed share and Expected, and a link to the Egress page filtered to it. Two reads of
// the same route: 30 days for the rows, today for the numbers.
const props = defineProps<{
  clusterId: string;
  kind: 'kubernetes' | 'server';
  /** The API's filters for this source (and the Egress page's link). */
  query: EgressQuery;
  /** The pod page: the rows are its workload's (flows have no pod label). */
  podNote?: boolean;
  now?: number;
}>();
const { t } = useI18n();
// The demo answers at most 24 hours: there the rows are the last day's.
const auth = useAuthStore();

const page = useLoader(async () => {
  const now = props.now ?? Date.now();
  const [month, today] = await Promise.all([
    api<Egress>(egressPath(props.clusterId, props.query, egressHistoryRange(auth.demoMode), now)),
    api<Egress>(egressPath(props.clusterId, props.query, '24h', now)),
  ]);
  const todays = new Map(today.rows.map((r) => [`${r.destination}:${r.port}`, r]));
  return {
    rows: month.rows.map((r) => ({ row: r, today: todays.get(`${r.destination}:${r.port}`) })),
    truncated: month.truncated,
    total: month.total,
  };
});
onMounted(page.load);

const rows = computed(() => page.data.value?.rows ?? []);
const line = (r: EgressRow, today: EgressRow | undefined) =>
  t('egress.talks.line', {
    since: firstSeenText(r, t, props.now),
    connections: (today?.connections ?? 0).toLocaleString('en'),
    failed: percent(today?.failedRatio ?? null),
  });
const link = computed(() => ({
  name: 'egress',
  query: { cluster: props.clusterId, ...props.query },
}));
</script>

<template>
  <section
    aria-labelledby="talks-title"
    class="overflow-hidden rounded-card border border-border bg-surface-1"
    data-testid="talks-to-internet"
  >
    <header
      class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border px-4 py-3"
    >
      <Globe class="size-4.5 shrink-0 text-info-text" aria-hidden="true" />
      <h2 id="talks-title" class="text-14 font-semibold text-text">
        {{ $t('egress.talks.title') }}
      </h2>
      <span class="ml-auto text-12 text-text-muted">{{ $t('egress.talks.window') }}</span>
    </header>

    <div
      v-if="!page.data.value && !page.error.value"
      class="flex flex-col gap-2 p-4"
      role="status"
      :aria-label="$t('common.loading')"
      data-testid="talks-loading"
    >
      <Skeleton class="w-3/5 text-13" />
      <Skeleton class="w-2/5 text-13" />
    </div>
    <div
      v-else-if="!page.data.value"
      class="flex flex-wrap items-center gap-3 px-4 py-3 text-13 text-text-muted"
      role="status"
      data-testid="talks-error"
    >
      <CircleAlert class="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
      <span class="min-w-0 flex-1">{{ $t('egress.talks.error') }}</span>
      <button type="button" class="text-link hover:underline max-lg:min-h-11" @click="page.load">
        {{ $t('common.retry') }}
      </button>
    </div>
    <template v-else>
      <p v-if="podNote" class="px-4 pt-3 text-12 text-text-subtle" data-testid="talks-pod-note">
        {{ $t('egress.talks.podNote') }}
      </p>
      <ul v-if="rows.length" class="flex flex-col px-4" data-testid="talks-rows">
        <li
          v-for="{ row, today } in rows"
          :key="`${row.destination}:${row.port}`"
          class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border py-3 last:border-b-0"
          data-testid="talks-row"
        >
          <div class="flex min-w-0 flex-col gap-1">
            <span class="break-all font-mono text-13 text-text"
              >{{ row.class === 'internet' ? $t('egress.internetRow') : row.destination
              }}<span v-if="row.port" class="text-text-muted">:{{ row.port }}</span></span
            >
            <span class="text-12 text-text-muted">{{ line(row, today) }}</span>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <EgressBadges :row="row" />
            <ExpectedActions
              v-if="row.sources.length"
              :row="row"
              :cluster-id="clusterId"
              :kind="kind"
              :source="row.sources[0]"
              @changed="page.load"
            />
          </div>
        </li>
      </ul>
      <p v-else class="px-4 py-3 text-13 text-text-muted" data-testid="talks-empty">
        {{ $t(`egress.talks.empty.${kind}`) }}
      </p>
      <p v-if="page.data.value.truncated" class="px-4 pb-2 text-12 text-text-subtle">
        {{ $t('egress.truncated', { shown: rows.length, total: page.data.value.total }) }}
      </p>
      <div class="border-t border-border px-4 py-2.5 text-13">
        <RouterLink
          :to="link"
          class="font-semibold text-link hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
          data-testid="talks-link"
          >{{ $t(`egress.talks.link.${kind}`) }}</RouterLink
        >
      </div>
    </template>
  </section>
</template>
