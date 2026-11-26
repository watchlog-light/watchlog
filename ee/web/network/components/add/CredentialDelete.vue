<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox, { type ComboboxOption } from '@/components/ui/ComboBox.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import { networkApi, type Credential, type ProfileDevice } from '../../api';

// Deleting a credential profile (1.0.2): asks first, naming it. A profile that devices use
// can't be deleted, so the dialog lists them and offers to move them to another profile of
// the same protocol; after the move, the delete goes through.
const props = defineProps<{ profile: Credential; profiles: Credential[] }>();
const emit = defineEmits<{ deleted: [id: string]; moved: [] }>();
const open = defineModel<boolean>('open', { required: true });
const { t } = useI18n();

const devices = ref<ProfileDevice[] | null>(null);
const error = ref('');
const busy = ref<'' | 'move' | 'delete'>('');
onMounted(async () => {
  try {
    devices.value = (await networkApi.credentialDevices(props.profile.id)).devices;
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('netAdd.remove.failed');
    devices.value = [];
  }
});

const others = computed<ComboboxOption[]>(() =>
  props.profiles
    .filter((c) => c.id !== props.profile.id && c.protocol === props.profile.protocol)
    .map((c) => ({ value: c.id, label: c.name })),
);
const to = ref<string | null>(null);
const inUse = computed(() => (devices.value?.length ?? 0) > 0);
const SHOWN = 8;

async function move() {
  if (!to.value) return;
  busy.value = 'move';
  error.value = '';
  try {
    await networkApi.moveCredentialDevices(props.profile.id, to.value);
    devices.value = [];
    emit('moved');
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('netAdd.remove.failed');
  } finally {
    busy.value = '';
  }
}
async function remove() {
  busy.value = 'delete';
  error.value = '';
  try {
    await networkApi.deleteCredential(props.profile.id);
    emit('deleted', props.profile.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('netAdd.remove.failed');
    // Someone added a device with it meanwhile: show them.
    devices.value =
      (await networkApi.credentialDevices(props.profile.id).catch(() => null))?.devices ??
      devices.value;
  } finally {
    busy.value = '';
  }
}
</script>

<template>
  <ModalDialog v-model:open="open" :title="$t('netAdd.remove.title')">
    <div class="flex flex-col gap-3 text-14 text-text" data-testid="cred-delete">
      <p class="font-mono text-13 break-all text-text" data-testid="cred-delete-name">
        {{ profile.name }}
      </p>
      <p v-if="devices === null" class="text-13 text-text-muted">{{ $t('common.loading') }}</p>
      <template v-else-if="inUse">
        <p data-testid="cred-delete-inuse">
          {{ $t('netAdd.remove.inUse', { n: devices.length }, devices.length) }}
        </p>
        <ul
          class="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-control border border-border bg-surface-2 px-3 py-2 text-13"
          data-testid="cred-delete-devices"
        >
          <li v-for="d in devices.slice(0, SHOWN)" :key="d.id" class="flex justify-between gap-3">
            <span class="min-w-0 truncate text-text">{{ d.name }}</span>
            <span class="shrink-0 font-mono text-12 text-text-muted">{{ d.address }}</span>
          </li>
          <li v-if="devices.length > SHOWN" class="text-text-muted">
            {{ $t('netAdd.remove.more', { n: devices.length - SHOWN }) }}
          </li>
        </ul>
        <template v-if="others.length">
          <div class="flex flex-col gap-1.5">
            <span class="text-13 font-medium text-text">{{ $t('netAdd.remove.moveTo') }}</span>
            <ComboBox
              v-model="to"
              :options="others"
              :label="$t('netAdd.remove.moveTo')"
              :placeholder="$t('netAdd.remove.choose')"
              testid="cred-delete-to"
            />
            <span class="text-12 text-text-muted">{{ $t('netAdd.remove.moveHint') }}</span>
          </div>
        </template>
        <p v-else class="text-13 text-text-muted" data-testid="cred-delete-noother">
          {{ $t(`netAdd.remove.noOther.${profile.protocol}`) }}
        </p>
      </template>
      <p v-else data-testid="cred-delete-unused">{{ $t('netAdd.remove.unused') }}</p>
      <p v-if="error" class="text-13 text-critical-text" role="alert">{{ error }}</p>
      <div class="flex flex-wrap justify-end gap-2">
        <BaseButton variant="secondary" data-testid="cred-delete-cancel" @click="open = false">{{
          $t('common.cancel')
        }}</BaseButton>
        <BaseButton
          v-if="inUse"
          :disabled="!to"
          :loading="busy === 'move'"
          data-testid="cred-delete-move"
          @click="move"
        >
          {{ $t('netAdd.remove.move', { n: devices?.length ?? 0 }, devices?.length ?? 0) }}
        </BaseButton>
        <BaseButton
          v-else
          variant="danger"
          :disabled="devices === null"
          :loading="busy === 'delete'"
          data-testid="cred-delete-confirm"
          @click="remove"
        >
          {{ $t('netAdd.remove.confirm') }}
        </BaseButton>
      </div>
    </div>
  </ModalDialog>
</template>
