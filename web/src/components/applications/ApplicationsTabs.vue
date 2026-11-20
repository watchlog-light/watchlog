<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useApplicationsStore } from '@/stores/applications';
import { useCertsJobsStore } from '@/stores/certsJobs';
import { useClustersStore } from '@/stores/clusters';

// Applications' three tabs (0.10, ADR-221): the monitored services (every cluster's), and the
// selected cluster's certificates and scheduled jobs, each with its count.
const route = useRoute();
const apps = useApplicationsStore();
const store = useCertsJobsStore();
const clusters = useClustersStore();

const clusterId = computed(() => clusters.selected?.id ?? null);
function load() {
  const id = clusterId.value;
  if (!id) return;
  void store.loadCerts(id).catch(() => undefined);
  void store.loadJobs(id).catch(() => undefined);
}
onMounted(load);
watch(clusterId, load);

const tabs = computed(() => [
  {
    name: 'applications',
    key: 'appTabs.services',
    n: apps.loaded ? apps.list.length : null,
    active: route.name === 'applications' || route.name === 'application',
  },
  {
    name: 'certificates',
    key: 'appTabs.certificates',
    n: store.certsFor === clusterId.value ? (store.certs?.certificates.length ?? null) : null,
    active: route.name === 'certificates' || route.name === 'certificate',
  },
  {
    name: 'scheduled-jobs',
    key: 'appTabs.jobs',
    n: store.jobsFor === clusterId.value ? (store.jobs?.jobs.length ?? null) : null,
    active: route.name === 'scheduled-jobs' || route.name === 'scheduled-job',
  },
]);
</script>

<template>
  <nav
    :aria-label="$t('appTabs.label')"
    class="-mx-1 flex overflow-x-auto border-b border-border"
    data-testid="application-tabs"
  >
    <RouterLink
      v-for="tab in tabs"
      :key="tab.name"
      :to="{ name: tab.name }"
      :aria-current="tab.active ? 'page' : undefined"
      :class="[
        'mx-1 inline-flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-1 text-14 whitespace-nowrap',
        tab.active
          ? 'border-primary font-semibold text-text'
          : 'border-transparent text-text-muted hover:text-text',
      ]"
      :data-testid="`tab-${tab.name}`"
    >
      {{ $t(tab.key) }}
      <span v-if="tab.n !== null" class="font-normal text-text-muted tabular-nums">{{
        tab.n
      }}</span>
    </RouterLink>
  </nav>
</template>
