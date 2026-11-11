<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleCheck } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import CauseChip from '@/components/causes/CauseChip.vue';
import { problemCause, say } from '@/lib/causes';
import { problemLink, type Overview } from '@/lib/overview';
import { since } from '@/lib/time';
import OverviewCard from './OverviewCard.vue';

// Needs attention: exactly the status strip's list. Firing alerts first, then object
// problems no alert covers; a title and a "why" line in words; age; a click opens the
// alert or the object. Under each, its cause (ADR-148, ADR-156): the chip and the likely
// cause's headline, the possible ones joined, or the "No clear cause" chip alone; never cut
// with an ellipsis (it wraps). The first ATTENTION_MAX items, worst first (ADR-159), so the
// card stays about as tall as the resources chart beside it; the rest are in Alerts.
defineProps<{ overview: Overview }>();
const ATTENTION_MAX = 6;
const { t } = useI18n();
const tr = (key: string, values?: Record<string, unknown>, plural?: number) =>
  plural === undefined ? t(key, values ?? {}) : t(key, values ?? {}, plural);
function causeOf(p: Overview['problems']['items'][number]) {
  const c = problemCause(p);
  return c ? { state: c.state, text: c.line.map((l) => say(tr, l)).join(' · ') } : null;
}
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
      <RouterLink
        :to="{ name: 'alerts' }"
        class="text-13 text-primary max-lg:inline-flex max-lg:min-h-11 max-lg:min-w-11 max-lg:items-center max-lg:justify-center"
        >{{ $t('overview.attention.all') }}</RouterLink
      >
    </template>
    <ul v-if="overview.problems.items.length" class="flex flex-col">
      <li v-for="p in overview.problems.items.slice(0, ATTENTION_MAX)" :key="p.id">
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
            <span
              v-if="causeOf(p)"
              class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1"
              data-testid="attention-cause"
            >
              <CauseChip :state="causeOf(p)!.state" />
              <span
                v-if="causeOf(p)!.text"
                class="min-w-0 flex-[1_1_12rem] text-12 break-words text-text"
                data-testid="attention-cause-text"
                >{{ causeOf(p)!.text }}</span
              >
            </span>
          </span>
          <span class="font-mono text-12 whitespace-nowrap text-text-subtle">{{
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
      v-if="overview.problems.items.length > ATTENTION_MAX"
      class="border-t border-border px-3.5 py-2.5 text-12 text-text-subtle"
    >
      {{ $t('overview.attention.more', { n: overview.problems.items.length - ATTENTION_MAX }) }}
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
  font-size: var(--text-12);
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
