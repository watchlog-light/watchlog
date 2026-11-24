<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed } from 'vue';
import { formatBytes } from '@/lib/units';
import { since } from '@/lib/time';
import type { NasCard } from '../../api';
import { statusTone } from '../../lib/format';
import { failing, smartTone, usedShare, volumeTone, type Tone } from '../../lib/storage';

// One NAS (ADR-234): its disks with temperature and SMART, its volumes and pools (use, RAID,
// state), its LUNs and which recorder is connected to each, its temperatures, and any fan or
// power supply that isn't fine.
const props = defineProps<{ nas: NasCard }>();

const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warning: 'bg-warning',
  critical: 'bg-critical',
  neutral: 'bg-text-subtle',
};
const TEXT: Record<Tone, string> = {
  ok: 'text-ok-text',
  warning: 'text-warning-text',
  critical: 'text-critical-text',
  neutral: 'text-text-muted',
};
const BAR: Record<Tone, string> = {
  ok: 'bg-info',
  warning: 'bg-warning',
  critical: 'bg-critical',
  neutral: 'bg-info',
};
const storage = computed(() => [
  ...props.nas.pools.map((v) => ({ ...v, kind: 'pool' as const })),
  ...props.nas.volumes.map((v) => ({ ...v, kind: 'volume' as const })),
]);
const broken = computed(() => [
  ...failing(props.nas.fans).map((f) => ({ ...f, kind: 'fan' as const })),
  ...failing(props.nas.psus).map((f) => ({ ...f, kind: 'psu' as const })),
]);
const pctText = (v: number | null) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const th = 'px-4 py-2 font-normal';
</script>

<template>
  <article
    class="flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface-1"
    data-testid="nas-card"
    :data-nas="nas.name"
  >
    <header
      class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3"
    >
      <div class="flex min-w-0 items-center gap-2">
        <span
          class="size-2 shrink-0 rounded-full"
          :class="DOT[statusTone(nas.status, nas.openAlerts)]"
          aria-hidden="true"
        />
        <RouterLink
          :to="{ name: 'network-device', params: { id: nas.id } }"
          class="inline-flex items-center font-mono text-14 text-text hover:underline max-md:min-h-11 max-md:min-w-11"
          >{{ nas.name }}</RouterLink
        >
        <span class="truncate text-13 text-text-muted">{{
          [nas.vendor, nas.model, nas.firmware].filter(Boolean).join(' · ')
        }}</span>
      </div>
      <span v-if="nas.sensors.length" class="flex flex-wrap gap-x-3 text-12 text-text-muted">
        <span v-for="s in nas.sensors" :key="s.name"
          >{{ s.name }}
          <span class="font-mono text-text">{{
            $t('netStorage.celsius', { c: Math.round(s.celsius) })
          }}</span></span
        >
      </span>
    </header>

    <p
      v-for="b in broken"
      :key="`${b.kind}-${b.name}`"
      class="border-b border-border bg-critical/10 px-4 py-2 text-13 text-critical-text"
      role="alert"
    >
      {{ $t(`netStorage.nas.${b.kind}Failing`, { name: b.name, state: b.state }) }}
    </p>

    <div v-if="nas.disks.length" class="relative overflow-x-auto">
      <table class="w-full min-w-[560px] text-13">
        <caption class="sr-only">
          {{
            $t('netStorage.nas.disks')
          }}
        </caption>
        <thead>
          <tr class="text-left font-mono text-11 tracking-[0.08em] text-text-subtle uppercase">
            <th :class="th">{{ $t('netStorage.nas.disk') }}</th>
            <th :class="th">{{ $t('netStorage.nas.model') }}</th>
            <th :class="`${th} text-right`">{{ $t('netStorage.nas.temp') }}</th>
            <th :class="th">{{ $t('netStorage.nas.smart') }}</th>
            <th :class="th">{{ $t('netStorage.nas.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="d in nas.disks"
            :key="d.index"
            class="border-t border-border"
            data-testid="nas-disk-row"
            :data-smart="d.smart"
          >
            <td class="px-4 py-2 font-mono text-text">
              {{ d.name || $t('netStorage.nas.bay', { n: d.index }) }}
            </td>
            <td class="px-4 py-2 text-text-muted">
              {{ d.model || '–'
              }}<template v-if="d.capacity"> · {{ formatBytes(d.capacity) }}</template>
            </td>
            <td
              class="px-4 py-2 text-right font-mono text-12 tabular"
              :class="d.celsius != null && d.celsius >= 50 ? 'text-warning-text' : ''"
            >
              {{ d.celsius == null ? '–' : $t('netStorage.celsius', { c: d.celsius }) }}
            </td>
            <td class="px-4 py-2">
              <span class="inline-flex items-center gap-1.5" :class="TEXT[smartTone(d.smart)]">
                <span
                  class="size-2 rounded-full"
                  :class="DOT[smartTone(d.smart)]"
                  aria-hidden="true"
                />{{ d.smart || '–' }}
              </span>
            </td>
            <td class="px-4 py-2 text-text-muted">
              {{ d.status && d.status !== 'unknown' ? d.status : '–' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="storage.length" class="flex flex-col border-t border-border">
      <h3 class="px-4 pt-3 font-mono text-11 tracking-[0.08em] text-text-subtle uppercase">
        {{ $t('netStorage.nas.volumes') }}
      </h3>
      <ul class="flex flex-col">
        <li
          v-for="v in storage"
          :key="`${v.kind}-${v.name}`"
          class="flex flex-col gap-1.5 border-t border-border px-4 py-2.5 first:border-t-0"
          data-testid="nas-volume-row"
          :data-state="v.status"
        >
          <div class="flex flex-wrap items-baseline justify-between gap-2 text-13">
            <span class="text-text">
              <span class="font-mono">{{ v.name }}</span>
              <span class="text-text-muted">
                · {{ $t(`netStorage.nas.${v.kind}`)
                }}<template v-if="v.raid"> · {{ v.raid }}</template>
                ·
              </span>
              <span class="font-semibold" :class="TEXT[volumeTone(v.status)]">{{
                v.status || '–'
              }}</span>
            </span>
            <span class="font-mono text-12 text-text-muted tabular">{{
              v.total
                ? $t('netStorage.nas.used', {
                    used: formatBytes(Math.max(0, v.total - v.free)),
                    total: formatBytes(v.total),
                    pct: pctText(usedShare(v.total, v.free)),
                  })
                : '–'
            }}</span>
          </div>
          <span
            v-if="usedShare(v.total, v.free) != null"
            class="block h-1.5 rounded-full bg-surface-3"
            aria-hidden="true"
          >
            <span
              class="block h-1.5 rounded-full"
              :class="BAR[volumeTone(v.status)]"
              :style="{ width: pctText(usedShare(v.total, v.free)) }"
            />
          </span>
        </li>
      </ul>
    </div>

    <div v-if="nas.luns.length" class="flex flex-col border-t border-border">
      <h3 class="px-4 pt-3 font-mono text-11 tracking-[0.08em] text-text-subtle uppercase">
        {{ $t('netStorage.nas.luns') }}
      </h3>
      <ul class="flex flex-col">
        <li
          v-for="l in nas.luns"
          :key="l.name"
          class="flex flex-col gap-1.5 border-t border-border px-4 py-2.5 first:border-t-0"
          data-testid="nas-lun-row"
        >
          <div class="flex flex-wrap items-baseline justify-between gap-2 text-13">
            <span class="font-mono text-text"
              >{{ l.name }}
              <span class="text-12 text-text-muted"
                >· {{ formatBytes(l.capacity)
                }}<template v-if="l.status"> · {{ l.status }}</template></span
              ></span
            >
            <span v-if="l.usedPercent != null" class="font-mono text-12 text-text-muted tabular">{{
              $t('netStorage.nas.lunUsed', { pct: Math.round(l.usedPercent) })
            }}</span>
          </div>
          <span
            v-if="l.usedPercent != null"
            class="block h-1.5 rounded-full bg-surface-3"
            aria-hidden="true"
          >
            <span
              class="block h-1.5 rounded-full bg-info"
              :style="{ width: `${Math.min(100, Math.max(0, l.usedPercent))}%` }"
            />
          </span>
          <span
            class="text-12"
            :class="l.session?.connected === false ? 'text-critical-text' : 'text-text-muted'"
          >
            <template v-if="l.session">
              <RouterLink
                :to="{ name: 'network-device', params: { id: l.session.recorderId } }"
                class="inline-flex items-center font-mono text-text hover:underline max-md:min-h-11 max-md:min-w-11"
                >{{ l.session.recorder }}</RouterLink
              >
              ·
              {{ l.session.connected ? $t('netStorage.connected') : $t('netStorage.lost')
              }}<template v-if="l.session.since">
                · {{ $t('netStorage.forTime', { t: since(l.session.since) }) }}</template
              >
            </template>
            <template v-else>{{
              l.mapped ? $t('netStorage.nas.noRecorder') : $t('netStorage.nas.notMapped')
            }}</template>
          </span>
        </li>
      </ul>
    </div>
  </article>
</template>
