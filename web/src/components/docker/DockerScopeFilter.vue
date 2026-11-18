<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Boxes, Layers, Server } from '@lucide/vue';
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import ComboBox from '@/components/ui/ComboBox.vue';
import { splitWorkload } from '@/lib/events';
import { useDockerScopeStore } from '@/stores/dockerScope';

// Top-bar filters on a Server fleet's pages (they replace the namespace filter). On the
// list pages (Overview, Containers, Events) the server filters (?host=); on Overview and
// Containers the Compose project too (?project=), on Events the workload with its kind
// (?workload=; the project is a facet there, within containers); on a server page the
// select switches server and the project filters its containers; on a container page the
// select leads to that server.
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const { hosts, projects, workloads } = storeToRefs(useDockerScopeStore());

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
const onEvents = computed(() => route.name === 'events');
const showProject = computed(
  () => !onEvents.value && (onList.value || route.name === 'docker-host'),
);
const workload = computed(() =>
  typeof route.query.workload === 'string' ? route.query.workload : '',
);
const workloadOptions = computed(() =>
  [...new Set([...workloads.value, workload.value].filter(Boolean))].sort().map((id) => {
    const w = splitWorkload(id);
    return { value: id, label: `${w.name} · ${t(`kube.events.facets.kind.${w.kind}`, w.kind)}` };
  }),
);

function setHost(value: string | null) {
  if (onList.value) void router.replace({ query: { ...route.query, host: value || undefined } });
  else if (value) void router.push({ name: 'docker-host', params: { host: value } });
  else void router.push({ name: 'hosts' });
}
function setWorkload(value: string | null) {
  void router.replace({ query: { ...route.query, workload: value || undefined } });
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
      :label="$t('docker.scope.server')"
      :placeholder="$t('docker.scope.allServers')"
      :icon="Server"
      variant="toolbar"
      clearable
      class="w-44 min-[1440px]:w-56"
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
      class="w-44 min-[1440px]:w-56"
      testid="scope-project"
      @update:model-value="setProject"
    />
    <ComboBox
      v-if="onEvents"
      :model-value="workload || null"
      :options="workloadOptions"
      :label="$t('docker.scope.workload')"
      :placeholder="$t('docker.scope.allWorkloads')"
      :icon="Boxes"
      variant="toolbar"
      clearable
      class="w-44 min-[1440px]:w-56"
      testid="scope-workload"
      @update:model-value="setWorkload"
    />
  </div>
</template>
