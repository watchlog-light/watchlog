<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import { useCompact } from '@/composables/useNarrow';
import { exactCores, heatTone } from '@/lib/resources';

// Pods (Docker: containers) as squares coloured by CPU against the request (Docker: the
// limit); failing pods red with ✕. Hover names the pod and its values; a click opens it.
// Below 1024 px the squares are too small to tap: they only show, and the node's row and
// the pod list lead to each pod.
export interface HeatPod {
  namespace: string | null;
  name: string;
  cpu: number | null;
  cpuRequest: number | null;
  cpuRatio: number | null;
  failing: string | null;
}
const props = defineProps<{
  pods: HeatPod[];
  link: (p: HeatPod) => RouteLocationRaw;
  docker?: boolean;
}>();
const { t } = useI18n();
const compact = useCompact();
const pct = (v: number) => `${Math.round(v * 100)}%`;

function label(p: HeatPod): string {
  const name = p.namespace && !props.docker ? `${p.namespace}/${p.name}` : p.name;
  if (p.failing) return t('heat.cellFailing', { name, reason: p.failing });
  if (p.cpu === null) return t('heat.cellNoData', { name });
  // Docker without a limit: CPU against one core.
  if (props.docker && p.cpuRequest === null && p.cpuRatio !== null)
    return t('heat.cellOneCore', { name, cpu: exactCores(p.cpu), pct: pct(p.cpuRatio) });
  if (p.cpuRequest === null || p.cpuRatio === null)
    return t(props.docker ? 'heat.cellNoLimit' : 'heat.cellNoRequest', {
      name,
      cpu: exactCores(p.cpu),
    });
  return t(props.docker ? 'heat.cellDocker' : 'heat.cell', {
    name,
    cpu: exactCores(p.cpu),
    req: exactCores(p.cpuRequest),
    pct: pct(p.cpuRatio),
  });
}
</script>

<template>
  <div class="heat" data-testid="heatmap">
    <component
      :is="compact ? 'span' : RouterLink"
      v-for="p in pods"
      :key="`${p.namespace}/${p.name}`"
      :to="compact ? undefined : link(p)"
      :role="compact ? 'img' : undefined"
      class="cell"
      :class="`h-${heatTone(p)}`"
      :title="label(p)"
      :aria-label="label(p)"
      data-testid="heat-cell"
    >
      <span v-if="p.failing" aria-hidden="true">✕</span>
    </component>
  </div>
</template>

<style scoped>
.heat {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14px, 1fr));
  gap: 3px;
}
.cell {
  display: flex;
  aspect-ratio: 1;
  max-width: 22px;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  color: var(--text);
}
.cell:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.h-fail {
  background: var(--critical);
}
.h-over {
  background: var(--warning);
}
.h-high {
  background: color-mix(in srgb, var(--ok) 85%, transparent);
}
.h-mid {
  background: color-mix(in srgb, var(--ok) 50%, transparent);
}
.h-low {
  background: color-mix(in srgb, var(--ok) 20%, transparent);
}
.h-none {
  background: var(--surface-3);
}
</style>
