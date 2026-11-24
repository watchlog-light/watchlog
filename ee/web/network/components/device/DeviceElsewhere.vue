<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { ArrowRight } from '@lucide/vue';
import { computed } from 'vue';
import type { DeviceDetail } from '../../api';
import KindIcon from '../KindIcon.vue';

// Access points, NASes, recorders and UPSes have no front panel to draw (0.17, ADR-234): their
// details live on the Wireless or Storage page; an access point also names its controller.
const props = defineProps<{ device: DeviceDetail['device'] }>();

const page = computed(() =>
  props.device.kind === 'ap'
    ? { name: 'network-wireless', label: 'netDevice.elsewhere.openWireless' }
    : { name: 'network-storage', label: 'netDevice.elsewhere.openStorage' },
);
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
    data-testid="device-elsewhere"
  >
    <div class="flex items-start gap-3">
      <KindIcon :kind="device.kind" class="mt-0.5 size-5 shrink-0 text-text-muted" />
      <p class="text-14 text-text">{{ $t(`netDevice.elsewhere.${device.kind}`) }}</p>
    </div>
    <div class="flex flex-wrap items-center gap-x-5 gap-y-1">
      <RouterLink
        :to="{ name: page.name }"
        class="inline-flex items-center gap-1.5 text-13 font-semibold text-link hover:underline max-md:min-h-11"
        data-testid="device-elsewhere-link"
        >{{ $t(page.label) }}<ArrowRight class="size-4" aria-hidden="true"
      /></RouterLink>
      <RouterLink
        v-if="device.kind === 'ap' && device.parentId"
        :to="{ name: 'network-device', params: { id: device.parentId } }"
        class="inline-flex items-center gap-1.5 text-13 text-link hover:underline max-md:min-h-11"
        data-testid="device-controller"
        >{{
          device.parentName
            ? $t('netDevice.elsewhere.controllerNamed', { name: device.parentName })
            : $t('netDevice.elsewhere.controller')
        }}</RouterLink
      >
    </div>
  </section>
</template>
