<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { NamespaceList, NamespaceSettings } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useLoader } from '@/composables/useLoader';
import { useAuthStore } from '@/stores/auth';
import { useKubeStore } from '@/stores/kube';

// Settings → General: the system namespaces the Workloads page and the overview's top
// workloads hide by default, and whether WatchLog's own namespace counts as one.
const { t } = useI18n();
const kube = useKubeStore();
const canManage = useAuthStore().user?.role !== 'viewer';
const system = ref<string[]>([]);
const watchlog = ref(true);
const known = ref<string[]>([]);
const page = useLoader(async () => {
  const s = await api<NamespaceSettings>('/settings/namespaces');
  system.value = [...s.system];
  watchlog.value = s.watchlog;
  // The cluster's namespaces to pick from; the list still works without a cluster.
  const cluster = await kube.ensure().catch(() => null);
  if (cluster)
    known.value = (
      await api<NamespaceList>(`/clusters/${cluster.id}/namespaces`).catch(() => ({
        namespaces: [],
      }))
    ).namespaces.map((n) => n.name);
  return s;
});
const options = computed(() =>
  [...new Set([...known.value, ...system.value])].sort().map((n) => ({ value: n, label: n })),
);
const saving = ref(false);
const saved = ref(false);
const error = ref<string>();

async function save(reset = false) {
  saving.value = true;
  saved.value = false;
  error.value = undefined;
  try {
    const s = await api<NamespaceSettings>('/settings/namespaces', {
      method: 'PUT',
      body: reset ? { system: null } : { system: system.value, watchlog: watchlog.value },
    });
    system.value = [...s.system];
    watchlog.value = s.watchlog;
    page.data.value = s;
    saved.value = true;
  } catch (err) {
    error.value =
      err instanceof ApiError && err.problem?.detail
        ? err.problem.detail
        : t('settings.namespaces.failed');
  } finally {
    saving.value = false;
  }
}

onMounted(page.load);
</script>

<template>
  <section class="flex max-w-3xl flex-col gap-4" data-testid="system-namespaces">
    <ErrorState
      v-if="page.error.value"
      :message="$t('settings.namespaces.loadFailed')"
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
        <h2 class="text-16 font-semibold text-text">{{ $t('settings.namespaces.title') }}</h2>
        <p class="mt-1 text-13 text-text-muted">{{ $t('settings.namespaces.intro') }}</p>
      </div>
      <ComboBox
        v-model="system"
        multiple
        :options="options"
        :label="$t('settings.namespaces.label')"
        :placeholder="$t('settings.namespaces.placeholder')"
        :disabled="!canManage"
        testid="system-namespaces-input"
      />
      <label class="inline-flex items-center gap-2 text-13 text-text-muted max-lg:min-h-11">
        <input
          v-model="watchlog"
          type="checkbox"
          class="accent-primary"
          :disabled="!canManage"
          data-testid="hide-watchlog"
        />
        {{ $t('settings.namespaces.watchlog') }}
      </label>
      <p v-if="error" class="text-13 text-critical" role="alert">{{ error }}</p>
      <div v-if="canManage" class="flex flex-wrap items-center gap-2">
        <BaseButton type="submit" :loading="saving" data-testid="save-namespaces">
          {{ $t('common.save') }}
        </BaseButton>
        <BaseButton
          v-if="!page.data.value?.isDefault"
          variant="secondary"
          data-testid="reset-namespaces"
          @click="save(true)"
        >
          {{ $t('settings.namespaces.reset') }}
        </BaseButton>
        <span v-if="saved" class="text-13 text-text-muted" role="status">{{
          $t('settings.saved')
        }}</span>
      </div>
    </form>
  </section>
</template>
