<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowRight, CircleCheck, CircleHelp, CircleX, TriangleAlert } from '@lucide/vue';
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { since } from '@/lib/time';
import { chipLink, type Overview } from '@/lib/overview';

// The status strip (replaces the big banner): severity in words, how many problems need
// attention (the same list as Needs attention), one chip per kind of problem opening
// the Alerts page filtered to it, and the silenced count. Healthy is a calm green strip;
// unknown while alerting is not running (ADR-088).
const props = defineProps<{ overview: Overview }>();
const p = computed(() => props.overview.problems);
const n = computed(() => p.value.items.length);
const state = computed(() => props.overview.health);
const ICON = {
  critical: CircleX,
  degraded: TriangleAlert,
  healthy: CircleCheck,
  unknown: CircleHelp,
};
const SYMBOL: Record<string, string> = { critical: '✕', warning: '▲' };
</script>

<template>
  <div
    class="strip flex flex-wrap items-center gap-3.5 rounded-[12px] border px-4 py-3"
    :class="`strip-${state}`"
    role="status"
    data-testid="status-strip"
  >
    <div class="flex items-center gap-2.5">
      <span
        class="flex size-[30px] shrink-0 items-center justify-center rounded-full"
        :class="`ico-${state}`"
      >
        <component :is="ICON[state]" class="size-4" aria-hidden="true" />
      </span>
      <div>
        <p class="text-15 font-semibold text-text" data-testid="strip-title">
          {{ $t(`overview.status.${state}`)
          }}<template v-if="n"> · {{ $t('overview.status.problems', { n }, n) }}</template>
        </p>
        <p class="text-13 text-text-muted">
          <template v-if="n">
            {{ $t('overview.status.breakdown', { critical: p.critical, warning: p.warning })
            }}<template v-if="p.oldestSince">
              · {{ $t('overview.status.oldest', { ago: since(p.oldestSince) }) }}</template
            >
          </template>
          <template v-else-if="state === 'unknown'">{{
            $t('overview.status.unknownWhy')
          }}</template>
          <template v-else>{{ $t('overview.status.healthyWhy') }}</template>
        </p>
      </div>
    </div>
    <div v-if="p.types.length || p.silenced" class="flex flex-wrap gap-1.5">
      <RouterLink
        v-for="t in p.types"
        :key="t.type"
        :to="chipLink(t)"
        class="chip"
        data-testid="strip-chip"
      >
        <span
          :class="t.severity === 'critical' ? 'text-critical' : 'text-warning'"
          aria-hidden="true"
          >{{ SYMBOL[t.severity] }}</span
        >
        {{ $t(`overview.status.types.${t.type}`, { n: t.count }, t.count) }}
      </RouterLink>
      <RouterLink
        v-if="p.silenced"
        :to="{ name: 'alerts', query: { view: 'silences' } }"
        class="chip text-text-subtle"
        data-testid="strip-silenced"
      >
        {{ $t('overview.status.silenced', { n: p.silenced }) }}
      </RouterLink>
    </div>
    <span class="flex-1" />
    <RouterLink
      :to="{ name: 'alerts' }"
      class="inline-flex items-center gap-1 text-13 text-primary"
    >
      {{ $t('overview.status.openAlerts') }} <ArrowRight class="size-3.5" aria-hidden="true" />
    </RouterLink>
  </div>
</template>

<style scoped>
.strip {
  background: var(--surface-1);
  border-color: var(--border);
}
.strip-critical {
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--critical) 10%, transparent), transparent 55%),
    var(--surface-1);
  border-color: color-mix(in srgb, var(--critical) 35%, transparent);
}
.strip-degraded {
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--warning) 10%, transparent), transparent 55%),
    var(--surface-1);
  border-color: color-mix(in srgb, var(--warning) 35%, transparent);
}
.strip-healthy {
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--ok) 8%, transparent), transparent 55%),
    var(--surface-1);
  border-color: color-mix(in srgb, var(--ok) 28%, transparent);
}
.ico-critical {
  background: color-mix(in srgb, var(--critical) 15%, transparent);
  color: var(--critical);
}
.ico-degraded {
  background: color-mix(in srgb, var(--warning) 15%, transparent);
  color: var(--warning);
}
.ico-healthy {
  background: color-mix(in srgb, var(--ok) 15%, transparent);
  color: var(--ok);
}
.ico-unknown {
  background: var(--surface-3);
  color: var(--text-muted);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  border-radius: 7px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text);
}
.chip:hover {
  border-color: var(--border-strong);
}
.chip:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
</style>
