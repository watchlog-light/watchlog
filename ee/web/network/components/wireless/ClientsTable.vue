<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { ArrowDown, ArrowUp, ArrowUpDown } from '@lucide/vue';
import { computed, ref } from 'vue';
import { formatBytes } from '@/lib/units';
import type { WifiClient } from '../../api';
import { uptimeText } from '../../lib/format';
import {
  apChips,
  bandLabel,
  dbmText,
  filterClients,
  isWeak,
  nextSort,
  signalBars,
  signalTone,
  type ClientSort,
} from '../../lib/wireless';

// The wireless clients (ADR-234): filter chips (all, weak signal, one access point), a search on
// MAC or vendor, sorted by access point or by signal. Scrolls sideways inside on a phone.
const props = defineProps<{ clients: WifiClient[]; weakDbm: number }>();

const filter = ref('all');
const q = ref('');
const sort = ref<ClientSort>('ap');
const shown = computed(() =>
  filterClients(props.clients, {
    filter: filter.value,
    q: q.value,
    sort: sort.value,
    weakDbm: props.weakDbm,
  }),
);
const weakCount = computed(() => props.clients.filter((c) => isWeak(c, props.weakDbm)).length);
const chips = computed(() => [
  { key: 'all', label: 'all', name: '', n: props.clients.length, testid: 'wifi-filter-all' },
  { key: 'weak', label: 'weak', name: '', n: weakCount.value, testid: 'wifi-filter-weak' },
  ...apChips(props.clients).map((a) => ({
    key: `ap:${a.id}`,
    label: '',
    name: a.name,
    n: a.n,
    testid: 'wifi-filter-ap',
  })),
]);

const TEXT = {
  ok: 'text-text',
  warning: 'text-warning-text',
  critical: 'text-critical-text',
  neutral: 'text-text-subtle',
} as const;
const BAR = {
  ok: 'bg-ok',
  warning: 'bg-warning',
  critical: 'bg-critical',
  neutral: 'bg-text-subtle',
} as const;
const sortIcon = computed(() =>
  sort.value === 'signal-asc' ? ArrowUp : sort.value === 'signal-desc' ? ArrowDown : ArrowUpDown,
);
const ariaSort = computed(() =>
  sort.value === 'signal-asc' ? 'ascending' : sort.value === 'signal-desc' ? 'descending' : 'none',
);
const SORT_KEY = { ap: 'ap', 'signal-asc': 'signalAsc', 'signal-desc': 'signalDesc' } as const;
const chip =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-13 max-md:h-11';
</script>

<template>
  <section
    class="overflow-hidden rounded-card border border-border bg-surface-1"
    aria-labelledby="wifi-clients-h"
  >
    <div class="flex flex-col gap-3 border-b border-border px-4 py-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="wifi-clients-h" class="text-14 font-semibold text-text">
          {{ $t('netWifi.clients.title') }}
        </h2>
        <input
          v-model="q"
          type="search"
          :placeholder="$t('netWifi.clients.search')"
          :aria-label="$t('netWifi.clients.search')"
          class="h-9 w-64 rounded-lg border border-border bg-surface-1 px-3 text-13 text-text max-md:h-11 max-md:w-full"
          data-testid="wifi-client-search"
        />
      </div>
      <div
        class="flex gap-1.5 overflow-x-auto"
        role="group"
        :aria-label="$t('netWifi.clients.filter')"
      >
        <button
          v-for="c in chips"
          :key="c.key"
          type="button"
          :class="[
            chip,
            filter === c.key
              ? 'border-border-strong bg-surface-2 text-text'
              : 'border-border text-text-muted hover:text-text',
          ]"
          :aria-pressed="filter === c.key"
          :data-testid="c.testid"
          @click="filter = c.key"
        >
          <span :class="c.label ? '' : 'font-mono'">{{
            c.label ? $t(`netWifi.clients.${c.label}`) : c.name
          }}</span>
          <span class="text-12 text-text-subtle tabular">{{ c.n }}</span>
        </button>
      </div>
    </div>
    <div class="relative overflow-x-auto">
      <table class="w-full min-w-[1080px] text-13" data-testid="wifi-clients-table">
        <thead>
          <tr class="text-left font-mono text-11 tracking-[0.08em] text-text-subtle uppercase">
            <th class="px-4 py-2 font-normal">{{ $t('netWifi.clients.mac') }}</th>
            <th class="px-4 py-2 font-normal">{{ $t('netWifi.clients.vendor') }}</th>
            <th class="px-4 py-2 font-normal" :aria-sort="sort === 'ap' ? 'ascending' : 'none'">
              {{ $t('netWifi.clients.ap') }}
            </th>
            <th class="px-4 py-2 font-normal">{{ $t('netWifi.clients.ssid') }}</th>
            <th class="px-4 py-2 font-normal">{{ $t('netWifi.clients.band') }}</th>
            <th class="px-2 py-1 font-normal" :aria-sort="ariaSort">
              <button
                type="button"
                class="inline-flex h-8 items-center gap-1 rounded-control px-2 font-mono text-11 tracking-[0.08em] uppercase hover:bg-surface-2 hover:text-text max-md:h-11"
                :class="sort === 'ap' ? '' : 'text-text'"
                data-testid="wifi-sort-signal"
                :data-sort="sort"
                @click="sort = nextSort(sort)"
              >
                {{ $t('netWifi.clients.signal') }}
                <component :is="sortIcon" class="size-3.5" aria-hidden="true" />
                <span class="sr-only">{{ $t(`netWifi.clients.sort.${SORT_KEY[sort]}`) }}</span>
              </button>
            </th>
            <th class="px-4 py-2 font-normal">{{ $t('netWifi.clients.rate') }}</th>
            <th class="px-4 py-2 text-right font-normal">{{ $t('netWifi.clients.connected') }}</th>
            <th class="px-4 py-2 text-right font-normal">{{ $t('netWifi.clients.traffic') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in shown"
            :key="c.mac"
            class="border-t border-border hover:bg-surface-2"
            data-testid="wifi-client-row"
            :data-weak="isWeak(c, weakDbm)"
          >
            <td class="px-4 py-2.5 font-mono text-12 text-text">{{ c.mac }}</td>
            <td class="px-4 py-2.5 text-text-muted">{{ c.vendor || '–' }}</td>
            <td class="px-4 py-2.5 font-mono text-12">
              <RouterLink
                v-if="c.apId"
                :to="{ name: 'network-device', params: { id: c.apId } }"
                class="inline-flex items-center text-text hover:underline max-md:min-h-11 max-md:min-w-11"
                >{{ c.ap }}</RouterLink
              >
              <span v-else>{{ c.ap || '–' }}</span>
            </td>
            <td class="px-4 py-2.5 text-text-muted">{{ c.ssid || '–' }}</td>
            <td class="px-4 py-2.5 whitespace-nowrap text-text-muted">
              {{ bandLabel(c.band) || '–' }}
            </td>
            <td class="px-4 py-2.5">
              <span class="inline-flex items-center gap-2 whitespace-nowrap">
                <span class="flex items-end gap-0.5" aria-hidden="true">
                  <span
                    v-for="i in 4"
                    :key="i"
                    class="w-1 rounded-[1px]"
                    :class="
                      i <= signalBars(c.signalDbm)
                        ? BAR[signalTone(c.signalDbm, weakDbm)]
                        : 'bg-surface-3'
                    "
                    :style="{ height: `${3 + i * 3}px` }"
                  />
                </span>
                <span
                  class="font-mono text-12 tabular"
                  :class="TEXT[signalTone(c.signalDbm, weakDbm)]"
                  >{{
                    c.signalDbm == null ? '–' : $t('netWifi.dbm', { n: dbmText(c.signalDbm) })
                  }}</span
                >
              </span>
            </td>
            <td class="px-4 py-2.5 font-mono text-12 whitespace-nowrap text-text-muted">
              {{ c.txRate || '–' }} / {{ c.rxRate || '–' }}
            </td>
            <td class="px-4 py-2.5 text-right font-mono text-12 tabular">
              {{ uptimeText(c.uptimeS) }}
            </td>
            <td class="px-4 py-2.5 text-right font-mono text-12 tabular">
              {{ formatBytes(c.bytes) }}
            </td>
          </tr>
          <tr v-if="shown.length === 0">
            <td colspan="9" class="px-4 py-4 text-13 text-text-muted">
              {{ $t('netWifi.clients.none') }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
