<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { MARKER_TOKEN, markerLabel, markerLink, type Overview } from '@/lib/overview';
import OverviewCard from './OverviewCard.vue';

// The latest changes of the last 7 days: rollouts, image changes, scaling, nodes and new
// namespaces, newest first, each opening what changed.
defineProps<{ overview: Overview }>();
const { t } = useI18n();
const time = (iso: string) =>
  new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  );
const day = (iso: string) =>
  new Date(iso).toDateString() === new Date().toDateString()
    ? null
    : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(iso));
const detail = (details: unknown) => {
  const d = details as Record<string, unknown>;
  if (Array.isArray(d.to)) return (d.to as string[]).map((x) => x.split('=').pop()).join(', ');
  if (d.from !== undefined && d.to !== undefined)
    return t('overview.changes.revision', { from: d.from, to: d.to });
  return '';
};
</script>

<template>
  <OverviewCard :title="$t('overview.changes.title')" testid="card-changes">
    <template #actions>
      <RouterLink :to="{ name: 'events' }" class="text-13 text-primary">{{
        $t('overview.changes.events')
      }}</RouterLink>
    </template>
    <ol v-if="overview.changes.length" class="flex flex-col px-3.5 pt-2 pb-3">
      <li
        v-for="m in overview.changes"
        :key="`${m.ts}-${m.target}-${m.kind}`"
        class="tli"
        data-testid="change"
      >
        <span class="font-mono text-12 text-text-subtle"
          >{{ time(m.ts) }}<br v-if="day(m.ts)" />{{ day(m.ts) }}</span
        >
        <span
          class="dt"
          :style="{ borderColor: `var(${MARKER_TOKEN[m.kind] ?? '--text-subtle'})` }"
          aria-hidden="true"
        />
        <span class="min-w-0 text-13">
          <RouterLink v-if="markerLink(m)" :to="markerLink(m)!" class="text-text hover:underline">{{
            markerLabel(m, t)
          }}</RouterLink>
          <template v-else>{{ markerLabel(m, t) }}</template>
          <small class="block truncate font-mono text-12 text-text-subtle">
            {{ [m.namespace, detail(m.details)].filter(Boolean).join(' · ') }}
          </small>
        </span>
      </li>
    </ol>
    <p v-else class="px-3.5 py-6 text-13 text-text-muted">{{ $t('overview.changes.empty') }}</p>
  </OverviewCard>
</template>

<style scoped>
.tli {
  display: grid;
  grid-template-columns: 52px 18px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  padding: 6px 0;
}
.dt {
  width: 10px;
  height: 10px;
  margin-top: 5px;
  border-radius: 50%;
  border: 2px solid;
}
</style>
