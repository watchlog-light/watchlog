<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useLoader } from '@/composables/useLoader';
import { useAuthStore } from '@/stores/auth';

// Settings → General: who may read container logs on demand (ADR-167). Every role by
// default; Owners and Admins change it, everyone else sees it.
type Access = 'all' | 'admins' | 'off';
const OPTIONS: Access[] = ['all', 'admins', 'off'];

const { t } = useI18n();
const canManage = useAuthStore().canManage;
const access = ref<Access>('all');
const page = useLoader(async () => {
  const s = await api<{ access: Access }>('/settings/logs');
  access.value = s.access;
  return s;
});
const saving = ref(false);
const saved = ref(false);
const error = ref<string>();

async function save() {
  saving.value = true;
  saved.value = false;
  error.value = undefined;
  try {
    const s = await api<{ access: Access }>('/settings/logs', {
      method: 'PUT',
      body: { access: access.value },
    });
    access.value = s.access;
    page.data.value = s;
    saved.value = true;
  } catch (err) {
    error.value =
      err instanceof ApiError && err.problem?.detail
        ? err.problem.detail
        : t('settings.logs.failed');
  } finally {
    saving.value = false;
  }
}

onMounted(page.load);
</script>

<template>
  <section class="flex max-w-3xl flex-col gap-4" data-testid="logs-access">
    <ErrorState
      v-if="page.error.value"
      :message="$t('settings.logs.loadFailed')"
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
      @submit.prevent="save"
    >
      <div>
        <h2 class="text-16 font-semibold text-text">{{ $t('settings.logs.title') }}</h2>
        <p class="mt-1 text-13 text-text-muted">{{ $t('settings.logs.intro') }}</p>
      </div>
      <fieldset v-if="canManage" class="flex flex-col gap-1">
        <legend class="mb-1 text-13 font-medium text-text">{{ $t('settings.logs.label') }}</legend>
        <label
          v-for="o in OPTIONS"
          :key="o"
          class="inline-flex min-h-9 items-center gap-2 text-13 text-text max-lg:min-h-11"
        >
          <input
            v-model="access"
            type="radio"
            name="logs-access"
            :value="o"
            class="accent-primary"
            :data-testid="`logs-access-${o}`"
          />
          {{ $t(`settings.logs.options.${o}`) }}
        </label>
      </fieldset>
      <p v-else class="text-13 text-text" data-testid="logs-access-readonly">
        {{ $t('settings.logs.current', { value: $t(`settings.logs.options.${access}`) }) }}
      </p>
      <p v-if="error" class="text-13 text-critical" role="alert">{{ error }}</p>
      <div v-if="canManage" class="flex flex-wrap items-center gap-2">
        <BaseButton type="submit" :loading="saving" data-testid="save-logs-access">
          {{ $t('common.save') }}
        </BaseButton>
        <span v-if="saved" class="text-13 text-text-muted" role="status">{{
          $t('settings.saved')
        }}</span>
      </div>
    </form>
  </section>
</template>
