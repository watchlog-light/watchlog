<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { Zap } from '@lucide/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Port } from '../../api';
import { PORT_FILL, parseName, portState } from '../../lib/front-panel';

// One port on the front panel: its number, coloured by state, a bolt when it powers something
// (PoE) and a dot when a neighbour is linked to it.
const props = defineProps<{ port: Port; selected: boolean; wide?: boolean; served?: boolean }>();
defineEmits<{ select: [] }>();
const { t } = useI18n();

const p = computed(() => props.port);
const label = computed(() => {
  const n = parseName(p.value.name).parts.at(-1);
  return n == null ? p.value.name.slice(0, 3) : String(n);
});
const aria = computed(() => {
  const parts = [
    `${p.value.name}: ${t(`netDevice.portState.${portState(p.value, props.served)}`)}`,
  ];
  if (p.value.poeWatts)
    parts.push(t('netDevice.port.poeShort', { w: p.value.poeWatts.toFixed(1) }));
  if (p.value.neighbour) {
    parts.push(
      t('netDevice.port.toNeighbour', {
        device: p.value.neighbour.device,
        port: p.value.neighbour.port,
      }),
    );
  }
  return parts.join(', ');
});
</script>

<template>
  <button
    type="button"
    class="relative h-6 shrink-0 rounded-[4px] border font-mono text-12 leading-none"
    :class="[
      PORT_FILL[portState(port, served)],
      wide ? 'w-[34px]' : 'w-[26px]',
      selected ? 'ring-2 ring-text ring-offset-1 ring-offset-bg' : '',
    ]"
    :aria-label="aria"
    :aria-pressed="selected"
    :title="aria"
    :data-testid="`port-${port.name}`"
    @click="$emit('select')"
  >
    {{ label }}
    <Zap
      v-if="port.poeWatts"
      class="absolute -top-1.5 -right-1.5 size-3 text-warning-text"
      aria-hidden="true"
    />
    <span
      v-if="port.neighbour"
      class="absolute -bottom-1 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-info"
      aria-hidden="true"
    />
  </button>
</template>
