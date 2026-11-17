<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue';
import { useClustersStore } from '@/stores/clusters';

// Workloads for both kinds (ADR-207): a cluster's controllers and pods, or a Server fleet's
// services, process groups and containers.
const KubeWorkloads = defineAsyncComponent(() => import('./WorkloadsPage.vue'));
const ServerWorkloads = defineAsyncComponent(() => import('./ServerWorkloadsPage.vue'));
const clusters = useClustersStore();
const isServer = computed(() => clusters.selected?.kind === 'server');
</script>

<template>
  <ServerWorkloads v-if="isServer" />
  <KubeWorkloads v-else />
</template>
