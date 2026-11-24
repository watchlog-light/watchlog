<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { clockTime, since } from '@/lib/time';
import type { DeviceDetail } from '../../api';

// The device's open alerts and its recent events (ADR-233), newest first; a port in an event
// picks that port on the panel.
defineProps<{ events: DeviceDetail['events']; alerts: DeviceDetail['alerts'] }>();
const emit = defineEmits<{ port: [name: string] }>();

const DOT = { info: 'bg-info', warning: 'bg-warning', critical: 'bg-critical' } as const;
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-2">
    <section
      class="flex flex-col overflow-hidden rounded-card border border-border bg-surface-1"
      aria-labelledby="al-h"
    >
      <h3 id="al-h" class="border-b border-border px-4 py-3 text-14 font-semibold text-text">
        {{ $t('netDevice.alerts.title') }}
      </h3>
      <p v-if="!alerts.length" class="px-4 py-3 text-13 text-text-muted">
        {{ $t('netDevice.alerts.none') }}
      </p>
      <ul v-else data-testid="device-alerts">
        <li v-for="a in alerts" :key="a.alertId" class="border-b border-border last:border-0">
          <RouterLink
            :to="{ name: 'alert', params: { id: a.alertId } }"
            class="flex items-start gap-3 px-4 py-2.5 text-13 hover:bg-surface-2 max-lg:min-h-11"
          >
            <span
              class="mt-1.5 size-2 shrink-0 rounded-full"
              :class="DOT[a.severity]"
              aria-hidden="true"
            />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="text-text">{{ a.what }}</span>
              <span class="text-text-muted"
                >{{ a.where }}<template v-if="a.why"> · {{ a.why }}</template></span
              >
            </span>
            <span class="shrink-0 text-12 text-text-subtle">{{
              $t('netDevice.ago', { t: since(a.since) })
            }}</span>
          </RouterLink>
        </li>
      </ul>
    </section>
    <section
      class="flex flex-col overflow-hidden rounded-card border border-border bg-surface-1"
      aria-labelledby="ev-h"
    >
      <h3 id="ev-h" class="border-b border-border px-4 py-3 text-14 font-semibold text-text">
        {{ $t('netDevice.events.title') }}
      </h3>
      <p v-if="!events.length" class="px-4 py-3 text-13 text-text-muted">
        {{ $t('netDevice.events.none') }}
      </p>
      <ul v-else class="max-h-96 overflow-y-auto" data-testid="device-events">
        <li
          v-for="(e, i) in events"
          :key="i"
          class="flex items-start gap-3 border-b border-border px-4 py-2.5 text-13 last:border-0"
        >
          <span
            class="mt-1.5 size-2 shrink-0 rounded-full"
            :class="DOT[e.severity]"
            aria-hidden="true"
          />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="text-text">{{ e.message }}</span>
            <span class="text-12 text-text-muted">
              {{ e.reason }}
              <template v-if="e.port">
                ·
                <button
                  type="button"
                  class="font-mono text-link hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:min-w-11 max-lg:items-center"
                  @click="emit('port', e.port)"
                >
                  {{ e.port }}
                </button>
              </template>
            </span>
          </span>
          <time :datetime="e.at" class="shrink-0 text-12 text-text-subtle" :title="clockTime(e.at)">
            {{ $t('netDevice.ago', { t: since(e.at) }) }}
          </time>
        </li>
      </ul>
    </section>
  </div>
</template>
