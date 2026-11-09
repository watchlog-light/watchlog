<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import TextField from '@/components/ui/TextField.vue';
import { serviceName, type ConnectTarget } from '@/lib/applications';
import { useClustersStore } from '@/stores/clusters';

// Add a service by hand (SPEC §4.12): one the agents can't see, such as a managed
// database, by its address. On a Docker fleet, the host whose collector reaches it.
// Continue opens the same connect drawer as a discovered service.
const emit = defineEmits<{ connect: [service: ConnectTarget] }>();
const open = defineModel<boolean>('open', { required: true });
const { t } = useI18n();
const clusters = useClustersStore();
onMounted(() => void clusters.ensure());

const TYPES = ['postgres', 'redis', 'rabbitmq', 'nginx'];
const clusterId = ref<string | null>(clusters.selectedId);
// The selected cluster, once the list has loaded.
watch(
  () => clusters.selectedId,
  (id) => {
    if (!clusterId.value) clusterId.value = id;
  },
);
const type = ref<string | null>('postgres');
const address = ref('');
const host = ref('');
const name = ref('');
const cluster = computed(() => clusters.list.find((c) => c.id === clusterId.value) ?? null);
const docker = computed(() => cluster.value?.kind === 'docker');
const ADDRESS = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9][A-Za-z0-9.-]*):[0-9]{1,5}$/;
const addressError = computed(() =>
  address.value && !ADDRESS.test(address.value.trim())
    ? t('applications.add.addressError')
    : undefined,
);
const valid = computed(
  () =>
    !!cluster.value &&
    !!type.value &&
    ADDRESS.test(address.value.trim()) &&
    (!docker.value || /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host.value.trim())),
);

function next() {
  if (!valid.value || !cluster.value || !type.value) return;
  const addr = address.value.trim();
  emit('connect', {
    cluster: { id: cluster.value.id, name: cluster.value.name, kind: cluster.value.kind },
    type: type.value,
    name: name.value.trim() || addr,
    version: null,
    image: null,
    port: Number(addr.slice(addr.lastIndexOf(':') + 1)),
    host: docker.value ? host.value.trim() : null,
    group: null,
    target: { kind: 'address', address: addr },
    ...(docker.value ? { collectorHost: host.value.trim() } : {}),
  });
}
</script>

<template>
  <ModalDialog
    v-model:open="open"
    :title="$t('applications.add.title')"
    :description="$t('applications.add.description')"
  >
    <form class="flex flex-col gap-4" data-testid="add-service" @submit.prevent="next">
      <div class="flex flex-col gap-1.5">
        <span class="text-13 font-medium text-text">{{ $t('applications.add.cluster') }}</span>
        <ComboBox
          v-model="clusterId"
          :options="
            clusters.list.map((c) => ({
              value: c.id,
              label: c.name,
              description: $t(`clusters.kind.${c.kind}`),
            }))
          "
          :label="$t('applications.add.cluster')"
          testid="add-cluster"
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-13 font-medium text-text">{{ $t('applications.add.type') }}</span>
        <ComboBox
          v-model="type"
          :options="TYPES.map((x) => ({ value: x, label: serviceName(x) }))"
          :label="$t('applications.add.type')"
          testid="add-type"
        />
      </div>
      <TextField
        v-model="address"
        :label="$t('applications.add.address')"
        :hint="$t('applications.add.addressHint')"
        :error="addressError"
        autocomplete="off"
      />
      <TextField
        v-if="docker"
        v-model="host"
        :label="$t('applications.add.host')"
        :hint="$t('applications.add.hostHint')"
        autocomplete="off"
      />
      <TextField v-model="name" :label="$t('applications.add.name')" autocomplete="off" />
      <div class="flex justify-end gap-2 border-t border-border pt-4">
        <BaseButton variant="secondary" @click="open = false">{{ $t('common.cancel') }}</BaseButton>
        <BaseButton type="submit" :disabled="!valid" data-testid="add-continue">{{
          $t('applications.add.continue')
        }}</BaseButton>
      </div>
    </form>
  </ModalDialog>
</template>
