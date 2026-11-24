<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import type { Device } from '../api';
import { pct, statusTone, uptimeText } from '../lib/format';
import KindIcon from './KindIcon.vue';

// Every device (ADR-233): name with its kind's icon, model, address, uptime, CPU, memory,
// temperature, ports up, firmware and the place that polls it. Overview and Devices share it.
defineProps<{ devices: Device[] }>();

const TONE: Record<string, string> = {
  ok: 'bg-ok',
  warning: 'bg-warning',
  critical: 'bg-critical',
  neutral: 'bg-text-subtle',
};
const statusKey = (d: Device) => (d.status === 'ok' && d.openAlerts > 0 ? 'warning' : d.status);
const hot = (v: number | null, warn: number) => (v != null && v >= warn ? 'text-warning-text' : '');
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full min-w-[980px] text-13" data-testid="network-devices-table">
      <thead>
        <tr class="text-left font-mono text-11 tracking-[0.08em] text-text-subtle uppercase">
          <th class="px-4 py-2 font-normal">{{ $t('net.table.device') }}</th>
          <th class="px-4 py-2 font-normal">{{ $t('net.table.model') }}</th>
          <th class="px-4 py-2 font-normal">{{ $t('net.table.status') }}</th>
          <th class="px-4 py-2 font-normal">{{ $t('net.table.address') }}</th>
          <th class="px-4 py-2 text-right font-normal">{{ $t('net.table.cpu') }}</th>
          <th class="px-4 py-2 text-right font-normal">{{ $t('net.table.memory') }}</th>
          <th class="px-4 py-2 text-right font-normal">{{ $t('net.table.temp') }}</th>
          <th class="px-4 py-2 text-right font-normal">{{ $t('net.table.ports') }}</th>
          <th class="px-4 py-2 font-normal">{{ $t('net.table.firmware') }}</th>
          <th class="px-4 py-2 text-right font-normal">{{ $t('net.table.uptime') }}</th>
          <th class="px-4 py-2 font-normal">{{ $t('net.table.poller') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="d in devices"
          :key="d.id"
          class="border-t border-border hover:bg-surface-2"
          data-testid="network-device-row"
        >
          <td class="px-4 py-2.5">
            <RouterLink
              :to="{ name: 'network-device', params: { id: d.id } }"
              class="flex items-center gap-2 font-mono text-text hover:underline max-md:min-h-11"
            >
              <KindIcon :kind="d.kind" class="size-4 shrink-0 text-text-muted" />
              {{ d.name }}
            </RouterLink>
          </td>
          <td class="px-4 py-2.5 text-text-muted">{{ d.model || '–' }}</td>
          <td class="px-4 py-2.5">
            <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span
                class="size-2 rounded-full"
                :class="TONE[statusTone(d.status, d.openAlerts)]"
                aria-hidden="true"
              />
              {{ $t(`net.status.${statusKey(d)}`) }}
            </span>
          </td>
          <td class="px-4 py-2.5 font-mono text-12 text-text-muted">{{ d.address }}</td>
          <td class="px-4 py-2.5 text-right font-mono text-12 tabular" :class="hot(d.cpu, 0.8)">
            {{ pct(d.cpu) }}
          </td>
          <td class="px-4 py-2.5 text-right font-mono text-12 tabular" :class="hot(d.memory, 0.85)">
            {{ pct(d.memory) }}
          </td>
          <td
            class="px-4 py-2.5 text-right font-mono text-12 tabular"
            :class="hot(d.temperature, 65)"
          >
            {{ d.temperature == null ? '–' : `${Math.round(d.temperature)} °C` }}
          </td>
          <td class="px-4 py-2.5 text-right font-mono text-12 tabular">
            {{ d.portsTotal ? `${d.portsUp} / ${d.portsTotal}` : '–' }}
          </td>
          <td class="px-4 py-2.5 font-mono text-12 text-text-muted">
            {{ d.firmware || '–' }}
            <span
              v-if="
                d.update?.latest && d.update.installed && d.update.latest !== d.update.installed
              "
              class="ml-1 text-info-text"
              >{{ $t('net.table.update', { v: d.update.latest }) }}</span
            >
          </td>
          <td class="px-4 py-2.5 text-right font-mono text-12 tabular">
            {{ uptimeText(d.uptimeS) }}
          </td>
          <td class="px-4 py-2.5 text-12 text-text-muted">
            {{ d.poller.host ? `${d.poller.name} › ${d.poller.host}` : d.poller.name }}
          </td>
        </tr>
        <tr v-if="devices.length === 0">
          <td colspan="11" class="px-4 py-4 text-13 text-text-muted">{{ $t('net.table.none') }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
