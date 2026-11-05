<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { TriangleAlert } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { useAuthStore } from '@/stores/auth';
import { useServerSettingsStore } from '@/stores/serverSettings';

// Alert messages link to WatchLog only when its address is known (ADR-081, ADR-093):
// offer the address in the browser with one click.
const store = useServerSettingsStore();
const canManage = useAuthStore().user?.role !== 'viewer';
const origin = window.location.origin;
const saving = ref(false);
async function use() {
  saving.value = true;
  try {
    await store.savePublicUrl(origin);
  } finally {
    saving.value = false;
  }
}
onMounted(() => void store.loadGeneral().catch(() => {}));
</script>

<template>
  <div
    v-if="store.general && !store.general.publicUrl"
    class="flex flex-wrap items-start gap-2 rounded-card border border-border bg-surface-2 px-3 py-2.5 text-13 text-text-muted"
    data-testid="public-address-notice"
  >
    <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
    <p class="min-w-0 flex-1">
      {{ $t('settings.publicAddressNotice.text') }}
      <template v-if="canManage">
        <b class="font-semibold text-text">{{
          $t('settings.publicAddressNotice.offer', { origin })
        }}</b>
        {{ $t('settings.publicAddressNotice.current') }}
      </template>
      <template v-else>{{ $t('settings.publicAddressNotice.askAdmin') }}</template>
    </p>
    <BaseButton
      v-if="canManage"
      variant="secondary"
      :loading="saving"
      data-testid="use-this-address"
      @click="use"
    >
      {{ $t('settings.general.publicUrl.useThisShort') }}
    </BaseButton>
  </div>
</template>
