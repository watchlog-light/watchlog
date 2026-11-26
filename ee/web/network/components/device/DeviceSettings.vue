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
// its credential profile; and removing it. An access point CAPsMAN manages is polled through its
// controller, so only its name changes here.
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
// 1.0.2: an address typed wrong is corrected here, and polling is paused and resumed.
const address = ref(props.device.address);
const addressOk = computed(() => /^[A-Za-z0-9.:_-]{1,253}$/.test(address.value.trim()));
const paused = computed(() => props.device.status === 'paused');
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

const saving = ref<'' | 'name' | 'poller' | 'credential' | 'address' | 'pause'>('');
const error = ref('');
const saved = ref('');
async function save(what: 'name' | 'poller' | 'credential' | 'address' | 'pause') {
  let body: Record<string, unknown>;
  if (what === 'name') body = { name: name.value.trim() };
  else if (what === 'address') body = { address: address.value.trim() };
  else if (what === 'pause') body = { paused: !paused.value };
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
    saved.value =
      what === 'pause'
        ? t(paused.value ? 'netDevice.settings.resumed' : 'netDevice.settings.pausedNow')
        : what === 'address'
          ? t('netDevice.settings.addressSaved')
          : t('netDevice.settings.saved');
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
      <form
        v-if="!device.managedAp"
        class="flex flex-col gap-2"
        data-testid="device-address-form"
        @submit.prevent="save('address')"
      >
        <TextField
          v-model="address"
          :label="$t('netDevice.settings.address')"
          :hint="$t('netDevice.settings.addressHint')"
          :maxlength="253"
          autocomplete="off"
          required
        />
        <BaseButton
          type="submit"
          variant="secondary"
          class="self-start"
          :loading="saving === 'address'"
          :disabled="!addressOk || address.trim() === device.address"
          data-testid="device-address-save"
        >
          {{ $t('netDevice.settings.changeAddress') }}
        </BaseButton>
      </form>
      <p v-if="device.managedAp" class="text-13 text-text-muted lg:col-span-2">
        {{ $t('netDevice.settings.managedAp') }}
      </p>
      <div v-if="!device.managedAp" class="flex flex-col gap-2">
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
      <div v-if="!device.managedAp" class="flex flex-col gap-2">
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
        <RouterLink
          v-if="device.credential"
          :to="{ name: 'network-add', query: { profile: device.credential.id } }"
          class="self-start text-13 text-link hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
          data-testid="device-edit-profile"
        >
          {{ $t('netDevice.settings.editProfile', { name: device.credential.name }) }}
        </RouterLink>
      </div>
    </div>
    <p v-if="error" class="text-13 text-critical-text" role="alert">{{ error }}</p>
    <p v-else-if="saved" class="text-13 text-ok-text" role="status">{{ saved }}</p>
    <div
      v-if="!device.managedAp"
      class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"
    >
      <p class="max-w-prose text-13 text-text-muted">
        {{ $t(paused ? 'netDevice.settings.pausedHint' : 'netDevice.settings.pauseHint') }}
      </p>
      <BaseButton
        variant="secondary"
        :loading="saving === 'pause'"
        data-testid="device-pause"
        @click="save('pause')"
      >
        {{ $t(paused ? 'netDevice.settings.resume' : 'netDevice.settings.pause') }}
      </BaseButton>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <p class="max-w-prose text-13 text-text-muted">{{ $t('netDevice.settings.removeHint') }}</p>
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
