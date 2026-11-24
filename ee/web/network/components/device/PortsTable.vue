<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Port } from '../../api';
import { speedText } from '../../lib/format';
import { portState } from '../../lib/front-panel';

// Every interface as a list (ADR-233): problems first by default, so a port that went down or
// has errors is on top; on a phone it's also the easier way to pick one.
const props = defineProps<{ ports: Port[]; selected: string | null; served: Set<string> }>();
const emit = defineEmits<{ select: [name: string] }>();

const all = ref(false);
const RANK = { down: 0, errors: 1, up: 2, idle: 3, 'admin-down': 4 } as const;
const rows = computed(() => {
  const ps = props.ports.filter(
    (p) => all.value || p.kind === 'ethernet' || p.kind === 'sfp' || p.kind === 'lag',
  );
  return [...ps].sort(
    (a, b) =>
      RANK[portState(a, props.served.has(a.name))] - RANK[portState(b, props.served.has(b.name))] ||
      a.index - b.index,
  );
});
const up = computed(
  () => props.ports.filter((p) => (p.kind === 'ethernet' || p.kind === 'sfp') && p.operUp).length,
);
const physical = computed(
  () => props.ports.filter((p) => p.kind === 'ethernet' || p.kind === 'sfp').length,
);
const withErrors = computed(() => props.ports.filter((p) => p.errorsRising).length);

const TEXT = {
  up: 'text-ok-text',
  errors: 'text-warning-text',
  down: 'text-critical-text',
  idle: 'text-text-subtle',
  'admin-down': 'text-text-subtle',
} as const;
</script>

<template>
  <section
    class="flex flex-col overflow-hidden rounded-card border border-border bg-surface-1"
    aria-labelledby="ports-h"
  >
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
      <h3 id="ports-h" class="text-14 font-semibold text-text">
        {{ $t('netDevice.ports.title') }}
      </h3>
      <div class="flex flex-wrap items-center gap-3 text-13 text-text-muted">
        <span>{{
          $t('netDevice.ports.summary', { up, total: physical, errors: withErrors })
        }}</span>
        <label class="inline-flex items-center gap-1.5 max-lg:min-h-11">
          <input v-model="all" type="checkbox" class="size-4 accent-primary" />{{
            $t('netDevice.ports.all')
          }}
        </label>
      </div>
    </div>
    <div class="max-h-[480px] overflow-auto">
      <table class="w-full min-w-[760px] text-13" data-testid="ports-table">
        <thead
          class="sticky top-0 bg-surface-1 text-11 tracking-[0.08em] text-text-subtle uppercase"
        >
          <tr class="border-b border-border text-left">
            <th class="px-4 py-2 font-normal">{{ $t('netDevice.ports.port') }}</th>
            <th class="px-4 py-2 font-normal">{{ $t('netDevice.ports.connected') }}</th>
            <th class="px-4 py-2 font-normal">{{ $t('netDevice.ports.speed') }}</th>
            <th class="px-4 py-2 font-normal">{{ $t('netDevice.ports.vlan') }}</th>
            <th class="px-4 py-2 font-normal">{{ $t('netDevice.ports.poe') }}</th>
            <th class="px-4 py-2 font-normal">{{ $t('netDevice.ports.state') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="p in rows"
            :key="p.name"
            class="cursor-pointer border-b border-border last:border-0 hover:bg-surface-2"
            :class="selected === p.name ? 'bg-surface-2' : ''"
            @click="emit('select', p.name)"
          >
            <td class="px-4 py-2">
              <button
                type="button"
                class="font-mono text-text hover:underline max-lg:min-h-11 max-lg:min-w-11"
                :aria-pressed="selected === p.name"
                @click.stop="emit('select', p.name)"
              >
                {{ p.name }}
              </button>
            </td>
            <td class="max-w-[280px] truncate px-4 py-2 text-text">
              <template v-if="p.neighbour"
                >{{ p.neighbour.device }} ·
                <span class="font-mono">{{ p.neighbour.port }}</span></template
              >
              <template v-else>{{ p.alias || p.descr || '–' }}</template>
            </td>
            <td class="px-4 py-2 font-mono text-text-muted">
              {{ p.operUp ? speedText(p.speedMbps) : '–' }}
            </td>
            <td class="px-4 py-2 font-mono text-text-muted">
              {{
                p.vlans.length > 3
                  ? $t('netDevice.ports.vlans', { n: p.vlans.length })
                  : p.vlans.join(', ') || '–'
              }}
            </td>
            <td class="px-4 py-2 font-mono text-text-muted">
              {{ p.poeWatts ? `${p.poeWatts.toFixed(1)} W` : '–' }}
            </td>
            <td class="px-4 py-2" :class="TEXT[portState(p, served.has(p.name))]">
              {{ $t(`netDevice.portState.${portState(p, served.has(p.name))}`) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
