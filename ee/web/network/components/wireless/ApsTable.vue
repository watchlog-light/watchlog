<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import type { AccessPoint } from '../../api';
import { uptimeText } from '../../lib/format';
import { radiosText } from '../../lib/wireless';
import SparkLine from './SparkLine.vue';

// The access points (ADR-234): status, model, radios, clients with their 24 h line, the switch
// port it hangs off, its controller and uptime. Scrolls sideways inside on a phone.
defineProps<{ aps: AccessPoint[] }>();

const DOT: Record<string, string> = {
  ok: 'bg-ok',
  provisioning: 'bg-warning',
  pending: 'bg-text-subtle',
};
const dot = (a: AccessPoint) => DOT[a.status] ?? 'bg-critical';
</script>

<template>
  <div class="relative overflow-x-auto">
    <table class="w-full min-w-[1040px] text-13" data-testid="wifi-aps-table">
      <thead>
        <tr class="text-left font-mono text-11 tracking-[0.08em] text-text-subtle uppercase">
          <th class="px-4 py-2 font-normal">{{ $t('netWifi.aps.name') }}</th>
          <th class="px-4 py-2 font-normal">{{ $t('netWifi.aps.status') }}</th>
          <th class="px-4 py-2 font-normal">{{ $t('netWifi.aps.model') }}</th>
          <th class="px-4 py-2 font-normal">{{ $t('netWifi.aps.radios') }}</th>
          <th class="px-4 py-2 font-normal">{{ $t('netWifi.aps.clients') }}</th>
          <th class="px-4 py-2 font-normal">{{ $t('netWifi.aps.switchPort') }}</th>
          <th class="px-4 py-2 font-normal">{{ $t('netWifi.aps.controller') }}</th>
          <th class="px-4 py-2 text-right font-normal">{{ $t('netWifi.aps.uptime') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="a in aps"
          :key="a.id"
          class="border-t border-border hover:bg-surface-2"
          data-testid="wifi-ap-row"
          :data-status="a.status"
        >
          <td class="px-4 py-2.5 whitespace-nowrap">
            <RouterLink
              :to="{ name: 'network-device', params: { id: a.id } }"
              class="inline-flex items-center font-mono text-text hover:underline max-md:min-h-11 max-md:min-w-11"
              >{{ a.name }}</RouterLink
            >
          </td>
          <td class="px-4 py-2.5">
            <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span class="size-2 shrink-0 rounded-full" :class="dot(a)" aria-hidden="true" />
              {{ $t(`netWifi.status.${a.status}`) }}
            </span>
          </td>
          <td class="px-4 py-2.5 whitespace-nowrap text-text-muted">{{ a.model || '–' }}</td>
          <td class="px-4 py-2.5 font-mono text-12 whitespace-nowrap text-text-muted">
            {{ radiosText(a.radios) || '–' }}
          </td>
          <td class="px-4 py-2.5">
            <span class="inline-flex items-center gap-2">
              <span class="w-6 text-right font-mono tabular">{{ a.clients }}</span>
              <SparkLine
                :values="a.spark"
                :label="$t('netWifi.aps.sparkLabel', { n: a.clients }, a.clients)"
              />
              <span v-if="a.weak" class="text-12 whitespace-nowrap text-warning-text">{{
                $t('netWifi.aps.weak', { n: a.weak }, a.weak)
              }}</span>
            </span>
          </td>
          <td class="px-4 py-2.5 font-mono text-12">
            <RouterLink
              v-if="a.switchPort"
              :to="{
                name: 'network-device',
                params: { id: a.switchPort.deviceId },
                query: { port: a.switchPort.port },
              }"
              class="inline-flex items-center whitespace-nowrap text-link hover:underline max-md:min-h-11 max-md:min-w-11"
              >{{ a.switchPort.device }} · {{ a.switchPort.port }}</RouterLink
            >
            <span v-else class="text-text-subtle">–</span>
          </td>
          <td class="px-4 py-2.5 text-12 text-text-muted">
            <RouterLink
              v-if="a.controllerId"
              :to="{ name: 'network-device', params: { id: a.controllerId } }"
              class="inline-flex items-center whitespace-nowrap hover:underline max-md:min-h-11 max-md:min-w-11"
              >{{ $t('netWifi.aps.controllerOn', { name: a.controller || '–' })
              }}<template v-if="a.generation"> · {{ a.generation }}</template></RouterLink
            >
          </td>
          <td class="px-4 py-2.5 text-right font-mono text-12 tabular">
            {{ uptimeText(a.uptimeS) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
