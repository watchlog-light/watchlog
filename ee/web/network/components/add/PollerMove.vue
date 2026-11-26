<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox, { type ComboboxOption } from '@/components/ui/ComboBox.vue';
import { networkApi, type PollerChoice } from '../../api';

// The devices one poller reads, and moving all of them to another poller at once (1.0.2):
// for when a server stops being a good place to poll from (it is being retired, or it lost
// its route to the devices). A device's own page moves one.
const props = defineProps<{
  from: { clusterId: string; host: string };
  /** How the poller is named on the page: the cluster, or the server. */
  name: string;
  devices: number;
  pollers: PollerChoice[];
}>();
const emit = defineEmits<{ moved: [] }>();
const { t } = useI18n();

const options = computed<ComboboxOption[]>(() =>
  props.pollers.flatMap<ComboboxOption>((p) =>
    (p.kind === 'kubernetes'
      ? [{ value: `${p.clusterId}/`, label: p.name, description: t('netAdd.poller.kubernetes') }]
      : p.hosts.map((h) => ({
          value: `${p.clusterId}/${h.host}`,
          label: h.host,
          group: p.name,
          description: h.collector ? undefined : t('netAdd.poller.noCollector'),
          disabled: !h.collector,
        }))
    ).filter(
      (o) =>
        o.value !== `${props.from.clusterId}/${props.from.host}` &&
        (p.kind !== 'kubernetes' || p.hosts[0]?.collector),
    ),
  ),
);
const open = ref(false);
const to = ref<string | null>(null);
const busy = ref(false);
const error = ref('');
async function move() {
  if (!to.value) return;
  const cut = to.value.indexOf('/');
  busy.value = true;
  error.value = '';
  try {
    await networkApi.movePoller(props.from, {
      clusterId: to.value.slice(0, cut),
      host: to.value.slice(cut + 1),
    });
    open.value = false;
    to.value = null;
    emit('moved');
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('netAdd.poller.moveFailed');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="devices > 0" class="flex flex-col gap-2 sm:pl-8" :data-testid="`poller-reads-${name}`">
    <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-text-muted">
      <span>{{ $t('netAdd.poller.reads', { n: devices }, devices) }}</span>
      <button
        v-if="!open && options.length"
        type="button"
        class="text-link hover:underline max-lg:min-h-11"
        :data-testid="`poller-move-${name}`"
        @click="open = true"
      >
        {{ $t('netAdd.poller.moveThem', { n: devices }, devices) }}
      </button>
    </p>
    <div
      v-if="open"
      class="flex flex-col gap-2 rounded-control border border-border bg-surface-1 p-3"
    >
      <span class="text-13 font-medium text-text">{{
        $t('netAdd.poller.moveTo', { n: devices, name }, devices)
      }}</span>
      <div class="flex flex-wrap items-center gap-2">
        <div class="min-w-0 flex-1 sm:max-w-80">
          <ComboBox
            v-model="to"
            :options="options"
            :label="$t('netAdd.poller.moveLabel')"
            :placeholder="$t('netAdd.poller.moveChoose')"
            testid="poller-move-to"
          />
        </div>
        <BaseButton :disabled="!to" :loading="busy" data-testid="poller-move-go" @click="move">
          {{ $t('netAdd.poller.move') }}
        </BaseButton>
        <BaseButton variant="secondary" @click="open = false">{{ $t('common.cancel') }}</BaseButton>
      </div>
      <p class="text-12 text-text-muted">{{ $t('netAdd.poller.moveHint') }}</p>
      <p v-if="error" class="text-13 text-critical-text" role="alert">{{ error }}</p>
    </div>
  </div>
</template>
