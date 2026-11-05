<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// A product screenshot in a window frame: WebP at two widths (scripts/screenshots.sh).
import overview800 from '~/assets/img/overview-800.webp';
import overview1400 from '~/assets/img/overview-1400.webp';
import serviceMap800 from '~/assets/img/service-map-800.webp';
import serviceMap1400 from '~/assets/img/service-map-1400.webp';
import workloads800 from '~/assets/img/workloads-800.webp';
import workloads1400 from '~/assets/img/workloads-1400.webp';

const SHOTS = {
  overview: [overview800, overview1400],
  'service-map': [serviceMap800, serviceMap1400],
  workloads: [workloads800, workloads1400],
} as const;

const props = defineProps<{
  shot: keyof typeof SHOTS;
  label: string;
  alt: string;
  sizes: string;
  eager?: boolean;
}>();
const [small, large] = SHOTS[props.shot];
</script>

<template>
  <div class="frame">
    <div class="chrome" aria-hidden="true">
      <i></i><i></i><i></i><span>{{ label }}</span>
    </div>
    <img
      :src="large"
      :srcset="`${small} 800w, ${large} 1400w`"
      :sizes="sizes"
      :alt="alt"
      width="1400"
      height="731"
      :loading="eager ? 'eager' : 'lazy'"
      :fetchpriority="eager ? 'high' : undefined"
      decoding="async"
    />
  </div>
</template>
