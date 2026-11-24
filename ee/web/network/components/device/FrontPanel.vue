<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { Zap } from '@lucide/vue';
import { computed } from 'vue';
import type { Port } from '../../api';
import { PORT_FILL, frontPanel, isCage, type PortState } from '../../lib/front-panel';
import PortButton from './PortButton.vue';

// The ports as on the front of the device (ADR-233): odd on top, even below, SFP cages to the
// right, one panel per stack member; pick one to see it below.
const props = defineProps<{
  model: string;
  ports: Port[];
  selected: string | null;
  served: Set<string>;
}>();
const emit = defineEmits<{ select: [name: string] }>();

const fp = computed(() => frontPanel(props.model, props.ports));
const LEGEND: PortState[] = ['up', 'errors', 'down', 'idle', 'admin-down'];
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap gap-x-4 gap-y-1 text-12 text-text-muted" aria-hidden="true">
      <span v-for="s in LEGEND" :key="s" class="inline-flex items-center gap-1.5">
        <span class="size-3 rounded-[3px] border" :class="PORT_FILL[s]" />{{
          $t(`netDevice.portState.${s}`)
        }}
      </span>
      <span class="inline-flex items-center gap-1.5">
        <Zap class="size-3 text-warning-text" />{{ $t('netDevice.legend.poe') }}
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="size-1.5 rounded-full bg-info" />{{ $t('netDevice.legend.neighbour') }}
      </span>
    </div>

    <p v-if="!fp.panels.length" class="text-13 text-text-muted">{{ $t('netDevice.noPorts') }}</p>

    <div
      v-for="(panel, pi) in fp.panels"
      :key="pi"
      class="flex flex-col gap-2 overflow-x-auto rounded-card border border-border bg-bg p-4"
      :data-testid="`front-panel-${panel.member ?? 0}`"
      data-layout-exempt="touch-target"
    >
      <span
        v-if="panel.member != null"
        class="text-11 tracking-[0.08em] text-text-subtle uppercase"
      >
        {{ $t('netDevice.member', { n: panel.member }) }}
      </span>
      <!-- Any other model: rows of ports in ifIndex order. -->
      <div v-if="panel.rows" class="flex flex-col gap-2">
        <div v-for="(row, ri) in panel.rows" :key="ri" class="flex w-max gap-1.5">
          <PortButton
            v-for="p in row"
            :key="p.name"
            :port="p"
            :wide="isCage(p)"
            :selected="selected === p.name"
            :served="served.has(p.name)"
            @select="emit('select', p.name)"
          />
        </div>
      </div>
      <div v-else class="flex w-max items-end gap-5">
        <div v-for="(block, bi) in panel.blocks" :key="bi" class="flex flex-col gap-2">
          <div v-for="(row, ri) in [block.top, block.bottom]" :key="ri" class="flex gap-1.5">
            <PortButton
              v-for="p in row"
              :key="p.name"
              :port="p"
              :selected="selected === p.name"
              :served="served.has(p.name)"
              @select="emit('select', p.name)"
            />
          </div>
        </div>
        <div v-if="panel.cages" class="ml-2 flex flex-col gap-2">
          <span class="text-11 tracking-[0.08em] text-text-subtle uppercase">{{
            $t('netDevice.uplinks')
          }}</span>
          <div
            v-for="(row, ri) in [panel.cages.top, panel.cages.bottom]"
            :key="ri"
            class="flex gap-1.5"
          >
            <PortButton
              v-for="p in row"
              :key="p.name"
              :port="p"
              wide
              :selected="selected === p.name"
              :served="served.has(p.name)"
              @select="emit('select', p.name)"
            />
          </div>
        </div>
      </div>
    </div>
    <p v-if="fp.model" class="text-12 text-text-subtle">
      {{ $t('netDevice.drawnAs', { model: fp.model }) }}
    </p>
  </div>
</template>
