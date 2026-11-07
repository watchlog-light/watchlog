<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import TextField from '@/components/ui/TextField.vue';
import { useLoader } from '@/composables/useLoader';
import { useAuthStore } from '@/stores/auth';
import { useServerSettingsStore } from '@/stores/serverSettings';

// Settings → General (ADR-093): the public address, used in alert links and install
// commands. When the server's environment sets it, it is shown read-only.
const { t } = useI18n();
const store = useServerSettingsStore();
const canManage = useAuthStore().canManage;
const origin = window.location.origin;
const value = ref('');
const page = useLoader(async () => {
  const g = await store.loadGeneral();
  value.value = g.publicUrl ?? '';
  return g;
});
const fromEnv = computed(() => page.data.value?.publicUrlSource === 'env');
const saving = ref(false);
const error = ref<string>();
const saved = ref(false);

async function save(url = value.value) {
  error.value = undefined;
  saved.value = false;
  saving.value = true;
  try {
    const g = await store.savePublicUrl(url.trim() || null);
    value.value = g.publicUrl ?? '';
    saved.value = true;
  } catch (err) {
    error.value =
      err instanceof ApiError && err.problem?.detail
        ? err.problem.detail
        : t('settings.general.failed');
  } finally {
    saving.value = false;
  }
}

onMounted(page.load);
</script>

<template>
  <section class="flex max-w-3xl flex-col gap-4" data-testid="general-settings">
    <ErrorState
      v-if="page.error.value"
      :message="$t('settings.general.loadFailed')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <div v-if="page.skeleton.value" class="rounded-card border border-border bg-surface-1 p-5">
      <Skeleton class="w-40 text-14" />
      <Skeleton shape="rect" class="mt-3 h-9 w-full" />
    </div>
    <form
      v-else-if="page.loaded.value"
      class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-5"
      novalidate
      @submit.prevent="save()"
    >
      <div>
        <h2 class="text-16 font-semibold text-text">
          {{ $t('settings.general.publicUrl.title') }}
        </h2>
        <p class="mt-1 text-13 text-text-muted">{{ $t('settings.general.publicUrl.intro') }}</p>
      </div>
      <TextField
        v-model="value"
        :label="$t('settings.general.publicUrl.label')"
        :placeholder="origin"
        :readonly="fromEnv || !canManage"
        :hint="fromEnv ? $t('settings.fromEnvironment') : $t('settings.general.publicUrl.hint')"
        :error="error"
      />
      <div v-if="!fromEnv && canManage" class="flex flex-wrap items-center gap-2">
        <BaseButton type="submit" :loading="saving" data-testid="save-public-url">
          {{ $t('common.save') }}
        </BaseButton>
        <BaseButton
          v-if="value !== origin"
          variant="secondary"
          data-testid="use-this-address"
          @click="save(origin)"
        >
          {{ $t('settings.general.publicUrl.useThis', { origin }) }}
        </BaseButton>
        <span v-if="saved" class="text-13 text-text-muted" role="status">{{
          $t('settings.saved')
        }}</span>
      </div>
    </form>
  </section>
</template>
