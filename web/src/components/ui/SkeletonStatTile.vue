<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import Skeleton from './Skeleton.vue';
</script>

<template>
  <!-- Same structure as a label (12 px) over a value (14 px mono). -->
  <div class="text-12">
    <Skeleton class="w-10" />
    <Skeleton class="w-14 font-mono text-14" />
  </div>
</template>
