<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { since } from '@/lib/time';
import type { ISCSISession } from '../../api';
import { bpsText } from '../../lib/format';

// The iSCSI sessions (ADR-234): each recorder's disk to its LUN on a NAS, connected or lost, for
// how long, and its throughput. The NAS gives no session table read-only, so these are seen
// from the recorder and the network; the page says so.
defineProps<{ sessions: ISCSISession[] }>();
</script>

<template>
  <section
    class="overflow-hidden rounded-card border border-border bg-surface-1"
    aria-labelledby="iscsi-h"
  >
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
      <div class="flex flex-col">
        <h2 id="iscsi-h" class="text-14 font-semibold text-text">
          {{ $t('netStorage.iscsi.title') }}
        </h2>
        <p class="text-12 text-text-muted" data-testid="iscsi-seen-from">
          {{ $t('netStorage.iscsi.seenFrom') }}
        </p>
      </div>
      <RouterLink
        :to="{ name: 'network-map', query: { layer: 'iscsi' } }"
        class="inline-flex items-center text-13 font-semibold text-link hover:underline max-md:min-h-11 max-md:min-w-11"
        data-testid="iscsi-map-link"
        >{{ $t('netStorage.iscsi.onMap') }}</RouterLink
      >
    </div>
    <div class="relative overflow-x-auto">
      <table class="w-full min-w-[760px] text-13">
        <thead>
          <tr class="text-left font-mono text-11 tracking-[0.08em] text-text-subtle uppercase">
            <th class="px-4 py-2 font-normal">{{ $t('netStorage.iscsi.recorder') }}</th>
            <th class="px-4 py-2 font-normal">{{ $t('netStorage.iscsi.lun') }}</th>
            <th class="px-4 py-2 font-normal">{{ $t('netStorage.iscsi.state') }}</th>
            <th class="px-4 py-2 text-right font-normal">{{ $t('netStorage.iscsi.since') }}</th>
            <th class="px-4 py-2 font-normal">{{ $t('netStorage.iscsi.throughput') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="s in sessions"
            :key="`${s.recorderId}-${s.disk}`"
            class="border-t border-border"
            data-testid="iscsi-session-row"
            :data-connected="s.connected"
          >
            <td class="px-4 py-2.5">
              <RouterLink
                :to="{ name: 'network-device', params: { id: s.recorderId } }"
                class="inline-flex items-center font-mono text-text hover:underline max-md:min-h-11 max-md:min-w-11"
                >{{ s.recorder }}</RouterLink
              >
              <span class="ml-1 font-mono text-12 text-text-subtle">{{ s.disk }}</span>
            </td>
            <td class="px-4 py-2.5 font-mono text-12">
              <span class="text-text-subtle" aria-hidden="true">→ </span>
              <span class="text-text">{{ s.lun }}</span>
              <template v-if="s.nas">
                <span class="text-text-muted"> {{ $t('netStorage.iscsi.on') }} </span>
                <RouterLink
                  v-if="s.nasId"
                  :to="{ name: 'network-device', params: { id: s.nasId } }"
                  class="inline-flex items-center text-text hover:underline max-md:min-h-11 max-md:min-w-11"
                  >{{ s.nas }}</RouterLink
                >
                <span v-else class="text-text">{{ s.nas }}</span>
              </template>
            </td>
            <td class="px-4 py-2.5">
              <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span
                  class="size-2 rounded-full"
                  :class="s.connected ? 'bg-ok' : 'bg-critical'"
                  aria-hidden="true"
                />
                <span :class="s.connected ? 'text-text' : 'text-critical-text'">{{
                  s.connected ? $t('netStorage.connected') : $t('netStorage.lost')
                }}</span>
              </span>
            </td>
            <td class="px-4 py-2.5 text-right font-mono text-12 text-text-muted tabular">
              <template v-if="!s.connected && s.lostAt">{{
                $t('netStorage.iscsi.lostAgo', { t: since(s.lostAt) })
              }}</template>
              <template v-else-if="s.since">{{ since(s.since) }}</template>
              <template v-else>–</template>
            </td>
            <td class="px-4 py-2.5 text-12">
              <span class="font-mono text-text tabular">{{
                !s.connected || s.throughputBps == null ? '–' : bpsText(s.throughputBps * 8)
              }}</span>
              <span v-if="s.throughputFrom" class="ml-1 font-mono text-text-subtle">{{
                $t('netStorage.iscsi.from', {
                  device: s.throughputFrom.device,
                  port: s.throughputFrom.port,
                })
              }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
