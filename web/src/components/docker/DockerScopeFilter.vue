<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Layers, Server } from '@lucide/vue';
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ComboBox from '@/components/ui/ComboBox.vue';
import { useDockerScopeStore } from '@/stores/dockerScope';

// Top-bar filters on a Docker fleet's pages (they replace the namespace filter). On the
// list pages (Overview, Hosts, Containers, Events) both filter (?host=&project=); on a
// host page the host select switches host and the project filters its containers; on a
// container page the host select leads to that host.
const route = useRoute();
const router = useRouter();
const { hosts, projects } = storeToRefs(useDockerScopeStore());

const LISTS = new Set(['overview', 'hosts', 'containers', 'events']);
const onList = computed(() => LISTS.has(String(route.name ?? '')));
const host = computed(() =>
  onList.value
    ? typeof route.query.host === 'string'
      ? route.query.host
      : ''
    : String(route.params.host ?? ''),
);
const project = computed(() =>
  typeof route.query.project === 'string' ? route.query.project : '',
);
const hostOptions = computed(() =>
  [...new Set([...hosts.value, host.value].filter(Boolean))].sort(),
);
const projectOptions = computed(() =>
  [...new Set([...projects.value, project.value].filter(Boolean))].sort(),
);
const showProject = computed(() => onList.value || route.name === 'docker-host');

function setHost(value: string | null) {
  if (onList.value) void router.replace({ query: { ...route.query, host: value || undefined } });
  else if (value) void router.push({ name: 'docker-host', params: { host: value } });
  else void router.push({ name: 'hosts' });
}
function setProject(value: string | null) {
  void router.replace({ query: { ...route.query, project: value || undefined } });
}
</script>

<template>
  <div class="flex items-center gap-2" data-testid="docker-scope">
    <ComboBox
      :model-value="host || null"
      :options="hostOptions.map((h) => ({ value: h, label: h }))"
      :label="$t('docker.scope.host')"
      :placeholder="$t('docker.scope.allHosts')"
      :icon="Server"
      variant="toolbar"
      clearable
      class="w-56"
      testid="scope-host"
      @update:model-value="setHost"
    />
    <ComboBox
      v-if="showProject"
      :model-value="project || null"
      :options="projectOptions.map((p) => ({ value: p, label: p }))"
      :label="$t('docker.scope.project')"
      :placeholder="$t('docker.scope.allProjects')"
      :icon="Layers"
      variant="toolbar"
      clearable
      class="w-56"
      testid="scope-project"
      @update:model-value="setProject"
    />
  </div>
</template>
