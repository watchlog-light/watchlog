<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Download } from '@lucide/vue';
import { ref } from 'vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { useCopy } from '@/composables/useCopy';

// Ten single-use recovery codes, shown once (ADR-175): copy, download as a text file, and
// "Done" only after the user ticks that they stored them, as the API token reveal does.
const props = defineProps<{ codes: string[] }>();
defineEmits<{ done: [] }>();
const ack = ref(false);
const copier = useCopy();
const text = () => `${props.codes.join('\n')}\n`;
const copyLabel = (state: 'idle' | 'copied' | 'failed') =>
  state === 'copied' ? 'common.copied' : state === 'failed' ? 'common.copyFailed' : 'common.copy';

function download() {
  const url = URL.createObjectURL(new Blob([text()], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'watchlog-recovery-codes.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="recovery-codes">
    <p class="text-13 text-warning">{{ $t('cloud.recovery.once') }}</p>
    <ul
      class="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-control border border-primary bg-bg px-4 py-3 font-mono text-14 text-text"
      :aria-label="$t('cloud.recovery.listLabel')"
    >
      <li v-for="c in codes" :key="c" data-testid="recovery-code">{{ c }}</li>
    </ul>
    <div class="flex flex-wrap gap-2">
      <BaseButton variant="secondary" data-testid="recovery-copy" @click="copier.copy(text())">
        <span aria-live="polite">{{ $t(copyLabel(copier.state.value)) }}</span>
      </BaseButton>
      <BaseButton variant="secondary" data-testid="recovery-download" @click="download">
        <Download class="size-4" aria-hidden="true" />{{ $t('cloud.recovery.download') }}
      </BaseButton>
    </div>
    <label class="flex items-start gap-2.5 text-13 text-text max-lg:min-h-11">
      <input
        v-model="ack"
        type="checkbox"
        class="mt-0.5 size-4 shrink-0 accent-primary max-lg:size-5"
        data-testid="recovery-ack"
      />
      {{ $t('cloud.recovery.ack') }}
    </label>
    <BaseButton :disabled="!ack" data-testid="recovery-done" @click="$emit('done')">
      {{ $t('cloud.recovery.done') }}
    </BaseButton>
  </div>
</template>
