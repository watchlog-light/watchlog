<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Cable } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { api } from '@/api/client';
import { networkOn, portLine } from '@/lib/network';
import { useAuthStore } from '@/stores/auth';
import { usePlanStore } from '@/stores/plan';

// The switch port a server or node is on (ADR-233): "sw-access-2 · Gi1/0/14 · 1 Gb/s", linked
// to the port on the device's page. Only where network devices are on (the module answers
// 404 elsewhere), and nothing when the server isn't behind a polled switch.
const props = defineProps<{ clusterId: string; node: string }>();
const auth = useAuthStore();
const plan = usePlanStore();
const on = computed(() =>
  networkOn({
    isCloud: auth.isCloud,
    demo: auth.demoMode,
    proFeatures: plan.info?.proFeatures,
    licenseFeatures: auth.license?.features,
  }),
);
interface Attachment {
  deviceId: string;
  device: string;
  port: string;
  speed: string;
  up: boolean | null;
}
const rows = ref<Attachment[]>([]);
watch(
  () => [on.value, props.clusterId, props.node] as const,
  async ([enabled, cluster, node]) => {
    rows.value = [];
    if (!enabled || !cluster || !node) return;
    try {
      const r = await api<{ attachments: Attachment[] }>(
        `/network/attachments?cluster=${encodeURIComponent(cluster)}&node=${encodeURIComponent(node)}`,
      );
      rows.value = r.attachments;
    } catch {
      rows.value = [];
    }
  },
  { immediate: true },
);
</script>

<template>
  <ul v-if="rows.length" class="flex flex-wrap gap-x-4 gap-y-1" data-testid="network-port-line">
    <li v-for="a in rows" :key="`${a.deviceId}/${a.port}`" class="flex items-center gap-1.5">
      <Cable class="size-3.5 text-text-subtle" aria-hidden="true" />
      <span class="sr-only">{{ $t('network.portLine.label') }}</span>
      <RouterLink
        :to="{ name: 'network-device', params: { id: a.deviceId }, query: { port: a.port } }"
        class="text-13 text-link hover:underline"
        :class="a.up === false ? 'text-critical-text' : ''"
        >{{ portLine(a) }}</RouterLink
      >
      <span v-if="a.up === false" class="text-12 text-critical-text">{{
        $t('network.portLine.down')
      }}</span>
    </li>
  </ul>
</template>
