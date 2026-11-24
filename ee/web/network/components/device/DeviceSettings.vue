<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox, { type ComboboxOption } from '@/components/ui/ComboBox.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import TextField from '@/components/ui/TextField.vue';
import { networkApi, type Credential, type DeviceDetail, type PollerChoice } from '../../api';

// What an Owner or Admin may change on a device (ADR-233): its name, the place that polls it,
// its credential profile; and removing it.
const props = defineProps<{ device: DeviceDetail['device'] }>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const router = useRouter();

const pollers = ref<PollerChoice[]>([]);
const credentials = ref<Credential[]>([]);
const loadError = ref('');
onMounted(async () => {
  try {
    const [p, c] = await Promise.all([networkApi.pollers(), networkApi.credentials()]);
    pollers.value = p.pollers;
    credentials.value = c.credentials;
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : t('netDevice.settings.loadError');
  }
});

const name = ref(props.device.name);
const poller = ref<string | null>(`${props.device.poller.clusterId}/${props.device.poller.host}`);
const credential = ref<string | null>(props.device.credential?.id ?? null);

const pollerOptions = computed<ComboboxOption[]>(() =>
  pollers.value.flatMap<ComboboxOption>((p) =>
    p.kind === 'kubernetes'
      ? [{ value: `${p.clusterId}/`, label: p.name, description: t('netAdd.poller.kubernetes') }]
      : p.hosts.map((h) => ({
          value: `${p.clusterId}/${h.host}`,
          label: h.host,
          group: p.name,
          description: h.collector ? undefined : t('netAdd.poller.noCollector'),
          disabled: !h.collector,
        })),
  ),
);
const credentialOptions = computed<ComboboxOption[]>(() =>
  credentials.value
    .filter((c) => c.protocol === props.device.protocol)
    .map((c) => ({ value: c.id, label: c.name })),
);

const saving = ref<'' | 'name' | 'poller' | 'credential'>('');
const error = ref('');
const saved = ref('');
async function save(what: 'name' | 'poller' | 'credential') {
  let body: Record<string, unknown>;
  if (what === 'name') body = { name: name.value.trim() };
  else if (what === 'credential') body = { credentialId: credential.value };
  else {
    const v = poller.value ?? '';
    const cut = v.indexOf('/');
    body = { clusterId: v.slice(0, cut), host: v.slice(cut + 1) };
  }
  saving.value = what;
  error.value = '';
  saved.value = '';
  try {
    await networkApi.updateDevice(props.device.id, body);
    saved.value = t('netDevice.settings.saved');
    emit('changed');
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('netDevice.settings.failed');
  } finally {
    saving.value = '';
  }
}

const removing = ref(false);
async function remove() {
  await networkApi.removeDevice(props.device.id);
  await router.push({ name: 'network-devices' });
}

const currentPoller = `${props.device.poller.clusterId}/${props.device.poller.host}`;
</script>

<template>
  <section
    class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-4"
    aria-labelledby="settings-h"
    data-testid="device-settings"
  >
    <h3 id="settings-h" class="text-14 font-semibold text-text">
      {{ $t('netDevice.settings.title') }}
    </h3>
    <p v-if="loadError" class="text-13 text-critical-text" role="alert">{{ loadError }}</p>
    <div class="grid gap-4 lg:grid-cols-3">
      <form class="flex flex-col gap-2" @submit.prevent="save('name')">
        <TextField
          v-model="name"
          :label="$t('netDevice.settings.name')"
          :maxlength="253"
          required
        />
        <BaseButton
          type="submit"
          variant="secondary"
          class="self-start"
          :loading="saving === 'name'"
          :disabled="!name.trim() || name.trim() === device.name"
        >
          {{ $t('netDevice.settings.rename') }}
        </BaseButton>
      </form>
      <div class="flex flex-col gap-2">
        <span class="text-13 font-medium text-text">{{ $t('netDevice.settings.poller') }}</span>
        <ComboBox
          v-model="poller"
          :options="pollerOptions"
          :label="$t('netDevice.settings.poller')"
        />
        <BaseButton
          variant="secondary"
          class="self-start"
          :loading="saving === 'poller'"
          :disabled="!poller || poller === currentPoller"
          @click="save('poller')"
        >
          {{ $t('netDevice.settings.move') }}
        </BaseButton>
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-13 font-medium text-text">{{ $t('netDevice.settings.profile') }}</span>
        <ComboBox
          v-model="credential"
          :options="credentialOptions"
          :label="$t('netDevice.settings.profile')"
        />
        <BaseButton
          variant="secondary"
          class="self-start"
          :loading="saving === 'credential'"
          :disabled="!credential || credential === device.credential?.id"
          @click="save('credential')"
        >
          {{ $t('netDevice.settings.useProfile') }}
        </BaseButton>
      </div>
    </div>
    <p v-if="error" class="text-13 text-critical-text" role="alert">{{ error }}</p>
    <p v-else-if="saved" class="text-13 text-ok-text" role="status">{{ saved }}</p>
    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <p class="text-13 text-text-muted">{{ $t('netDevice.settings.removeHint') }}</p>
      <BaseButton variant="danger" data-testid="device-remove" @click="removing = true">
        {{ $t('netDevice.settings.remove') }}
      </BaseButton>
    </div>
    <ConfirmDialog
      v-model:open="removing"
      :title="$t('netDevice.settings.removeTitle')"
      :subject="device.name"
      :lines="[$t('netDevice.settings.removeLine')]"
      :confirm-label="$t('netDevice.settings.remove')"
      :action="remove"
      testid="device-remove-confirm"
    />
  </section>
</template>
