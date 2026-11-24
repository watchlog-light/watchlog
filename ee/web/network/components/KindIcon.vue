<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import {
  BatteryCharging,
  Boxes,
  Camera,
  Cctv,
  CircleHelp,
  Cloud,
  EthernetPort,
  HardDrive,
  Network,
  Router,
  Server,
  Shield,
  Wifi,
} from '@lucide/vue';
import { computed, type Component } from 'vue';

// An icon per kind (ADR-233): router, L3 switch, switch, AP, NAS, NVR, UPS, server, node,
// camera, the Internet, unknown.
const props = defineProps<{ kind: string }>();
const ICONS: Record<string, Component> = {
  internet: Cloud,
  router: Router,
  firewall: Shield,
  l3switch: Network,
  switch: EthernetPort,
  ap: Wifi,
  nas: HardDrive,
  nvr: Cctv,
  ups: BatteryCharging,
  server: Server,
  node: Boxes,
  camera: Camera,
};
const icon = computed(() => ICONS[props.kind] ?? CircleHelp);
</script>

<template>
  <component :is="icon" aria-hidden="true" />
</template>
