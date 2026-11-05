<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleCheck } from '@lucide/vue';
import { RouterLink } from 'vue-router';
import { problemLink, type Overview } from '@/lib/overview';
import { since } from '@/lib/time';
import OverviewCard from './OverviewCard.vue';

// Needs attention: exactly the status strip's list. Firing alerts first, then object
// problems no alert covers; a title and a "why" line in words; age; a click opens the
// alert or the object.
defineProps<{ overview: Overview }>();
</script>

<template>
  <OverviewCard :title="$t('overview.attention.title')" testid="card-attention">
    <template #meta>
      <span
        v-if="overview.problems.items.length"
        class="rounded-full px-2 py-px text-12 font-medium"
        :class="overview.problems.critical ? 'pill-crit' : 'pill-warn'"
        data-testid="attention-count"
        >{{ overview.problems.items.length }}</span
      >
    </template>
    <template #actions>
      <RouterLink :to="{ name: 'alerts' }" class="text-13 text-primary">{{
        $t('overview.attention.all')
      }}</RouterLink>
    </template>
    <ul v-if="overview.problems.items.length" class="flex flex-col">
      <li v-for="p in overview.problems.items.slice(0, 8)" :key="p.id">
        <RouterLink :to="problemLink(p)" class="ai" data-testid="attention-item">
          <span
            class="sv"
            :class="p.severity === 'critical' ? 'sv-crit' : 'sv-warn'"
            :aria-label="$t(`overview.severity.${p.severity}`)"
          >
            {{ p.severity === 'critical' ? '✕' : '▲' }}
          </span>
          <span class="min-w-0">
            <span class="block text-13 font-medium text-text">{{ p.title }}</span>
            <span
              v-if="p.why"
              class="line-clamp-2 text-12 break-words text-text-muted"
              :title="p.why"
              >{{ p.why
              }}<template v-if="p.related">
                · {{ $t('overview.attention.related', { n: p.related }, p.related) }}</template
              ></span
            >
          </span>
          <span class="font-mono text-11 whitespace-nowrap text-text-subtle">{{
            p.since ? since(p.since) : ''
          }}</span>
        </RouterLink>
      </li>
    </ul>
    <div v-else class="flex items-center gap-2 px-3.5 py-6 text-13 text-text-muted">
      <CircleCheck class="size-4 text-ok" aria-hidden="true" />
      {{
        overview.health === 'unknown'
          ? $t('overview.attention.unknown')
          : $t('overview.attention.none')
      }}
    </div>
    <p
      v-if="overview.problems.items.length > 8"
      class="border-t border-border px-3.5 py-2.5 text-12 text-text-subtle"
    >
      {{ $t('overview.attention.more', { n: overview.problems.items.length - 8 }) }}
    </p>
    <p
      v-if="overview.kind === 'kubernetes' && overview.problems.items.length"
      class="mt-auto border-t border-border px-3.5 py-2.5 text-12 text-text-subtle"
    >
      {{ $t('overview.attention.note') }}
    </p>
  </OverviewCard>
</template>

<style scoped>
.ai {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
}
li:last-child .ai {
  border-bottom: 0;
}
.ai:hover {
  background: var(--surface-2);
}
.ai:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}
.sv {
  display: flex;
  width: 22px;
  height: 22px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  margin-top: 1px;
  font-size: 11px;
  font-weight: 700;
}
.sv-crit,
.pill-crit {
  background: color-mix(in srgb, var(--critical) 15%, transparent);
  color: var(--critical);
}
.sv-warn,
.pill-warn {
  background: color-mix(in srgb, var(--warning) 15%, transparent);
  color: var(--warning);
}
.text-ok {
  color: var(--ok);
}
</style>
