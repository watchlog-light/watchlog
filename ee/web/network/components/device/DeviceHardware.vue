<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed } from 'vue';
import type { DeviceDetail } from '../../api';
import { healthTone, opticReading } from '../../lib/front-panel';

// The device's hardware (ADR-233): fans and power supplies with their state, each optic's
// light levels against its thresholds, temperature sensors, and a stack's members.
const props = defineProps<{ health: DeviceDetail['health'] }>();

const TONE = {
  ok: 'bg-ok',
  warning: 'bg-warning',
  critical: 'bg-critical',
  neutral: 'bg-text-subtle',
} as const;
const TEXT = {
  ok: 'text-text-muted',
  warning: 'text-warning-text',
  critical: 'text-critical-text',
  neutral: 'text-text-subtle',
} as const;

const parts = computed(() => [
  ...props.health.psus.map((x) => ({ kind: 'psu' as const, ...x })),
  ...props.health.fans.map((x) => ({ kind: 'fan' as const, ...x })),
]);
const missingMembers = computed(() =>
  Math.max(0, props.health.stackExpected - props.health.stack.length),
);
</script>

<template>
  <div class="flex flex-col gap-4">
    <section
      v-if="parts.length || health.sensors.length"
      class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
      aria-labelledby="hw-h"
    >
      <h3 id="hw-h" class="text-14 font-semibold text-text">
        {{ $t('netDevice.hardware.title') }}
      </h3>
      <ul class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
        <li
          v-for="x in parts"
          :key="`${x.kind}-${x.name}`"
          class="flex items-center gap-2 rounded-control border border-border bg-surface-2 px-3 py-2 text-13"
        >
          <span
            class="size-2 shrink-0 rounded-full"
            :class="TONE[healthTone(x.state)]"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate text-text">
            {{ $t(`netDevice.hardware.${x.kind}`) }} · {{ x.name }}
          </span>
          <span :class="TEXT[healthTone(x.state)]">{{ x.state }}</span>
        </li>
        <li
          v-for="s in health.sensors"
          :key="`sensor-${s.name}`"
          class="flex items-center gap-2 rounded-control border border-border bg-surface-2 px-3 py-2 text-13"
        >
          <span
            class="size-2 shrink-0 rounded-full"
            :class="
              TONE[
                s.threshold != null && s.celsius >= s.threshold
                  ? 'critical'
                  : healthTone(s.state ?? 'ok')
              ]
            "
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate text-text">{{ s.name }}</span>
          <span class="font-mono text-text-muted">
            {{ $t('netDevice.hardware.celsius', { c: s.celsius }) }}
            <template v-if="s.threshold != null">
              / {{ $t('netDevice.hardware.celsius', { c: s.threshold }) }}</template
            >
          </span>
        </li>
      </ul>
    </section>

    <section
      v-if="health.optics.length"
      class="flex flex-col overflow-hidden rounded-card border border-border bg-surface-1"
      aria-labelledby="sfp-h"
    >
      <h3 id="sfp-h" class="border-b border-border px-4 py-3 text-14 font-semibold text-text">
        {{ $t('netDevice.optics.title') }}
      </h3>
      <div class="relative overflow-x-auto">
        <table class="w-full min-w-[560px] text-13" data-testid="device-optics">
          <thead class="text-11 tracking-[0.08em] text-text-subtle uppercase">
            <tr class="border-b border-border text-left">
              <th class="px-4 py-2 font-normal">{{ $t('netDevice.optics.port') }}</th>
              <th class="px-4 py-2 font-normal">{{ $t('netDevice.optics.rx') }}</th>
              <th class="px-4 py-2 font-normal">{{ $t('netDevice.optics.tx') }}</th>
              <th class="px-4 py-2 font-normal">{{ $t('netDevice.optics.temp') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="o in health.optics"
              :key="o.port"
              class="border-b border-border last:border-0"
            >
              <td class="px-4 py-2 font-mono text-text">{{ o.port }}</td>
              <td
                v-for="r in [
                  opticReading('rx', o.rxDbm, o.rxLow, o.rxHigh),
                  opticReading('tx', o.txDbm, o.txLow, o.txHigh),
                ]"
                :key="r.key"
                class="px-4 py-2"
              >
                <span class="font-mono" :class="TEXT[r.tone]">{{ r.value }}</span>
                <span v-if="r.range" class="ml-2 text-12 text-text-subtle">{{ r.range }}</span>
              </td>
              <td class="px-4 py-2 font-mono text-text-muted">
                {{ o.celsius != null ? $t('netDevice.hardware.celsius', { c: o.celsius }) : '–' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section
      v-if="health.stack.length || health.stackExpected"
      class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
      aria-labelledby="stack-h"
    >
      <h3 id="stack-h" class="text-14 font-semibold text-text">
        {{ $t('netDevice.stack.title') }}
        <span v-if="health.stackExpected" class="font-normal text-text-muted">
          · {{ $t('netDevice.stack.count', { n: health.stack.length, of: health.stackExpected }) }}
        </span>
      </h3>
      <p v-if="missingMembers" class="text-13 text-critical-text" role="alert">
        {{ $t('netDevice.stack.missing', { n: missingMembers }, missingMembers) }}
      </p>
      <ul
        class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2"
        data-testid="device-stack"
      >
        <li
          v-for="m in health.stack"
          :key="m.number"
          class="flex flex-col gap-1 rounded-control border border-border bg-surface-2 px-3 py-2 text-13"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="font-semibold text-text">{{
              $t('netDevice.member', { n: m.number })
            }}</span>
            <span :class="TEXT[healthTone(m.state)]">{{ m.state }}</span>
          </div>
          <span class="text-text-muted"
            >{{ m.role }}<template v-if="m.model"> · {{ m.model }}</template></span
          >
          <span v-if="m.serial" class="font-mono text-12 text-text-subtle">{{ m.serial }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
