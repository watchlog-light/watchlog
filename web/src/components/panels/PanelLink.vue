<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { linkRoute, type PanelLink } from '@/lib/service-links';
import { useServicePage } from '@/lib/service-page';

// A panel's link (1.1.0): a page of WatchLog's, or the docs in a new tab.
const props = defineProps<{ link: PanelLink }>();
const page = useServicePage();
const to = computed(() => linkRoute(props.link, page.appId, page.clusterId));
</script>

<template>
  <RouterLink
    v-if="to"
    :to="to"
    class="text-primary hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
    ><slot
  /></RouterLink>
  <a
    v-else-if="link.kind === 'docs'"
    :href="link.href"
    target="_blank"
    rel="noopener"
    class="text-primary hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
    ><slot
  /></a>
  <span v-else><slot /></span>
</template>
