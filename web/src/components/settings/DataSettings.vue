<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Download, Trash2 } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { cloudApi, cloudErrorKey, exportUrls } from '@/api/cloud';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import TextField from '@/components/ui/TextField.vue';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { useOrgStatusStore } from '@/stores/orgStatus';

// Settings › Data (ADR-181), Cloud only: the org's data rights, for its Owners.
//   - Export: the configuration as JSON (no secrets), and a cluster's metrics for a range as
//     JSON lines. Both are plain downloads; the server limits how often and records each.
//   - Delete: type the org's name, then 7 days to undo (agents' data isn't stored meanwhile);
//     after that everything is deleted for good. While it's scheduled: the day, and Undo.
// Others see what it is and that an Owner does it.
const { t } = useI18n();
const auth = useAuthStore();
const clusters = useClustersStore();
const store = useOrgStatusStore();

const isOwner = computed(() => auth.user?.role === 'owner' && !auth.support);
const orgName = computed(() => auth.user?.org.name ?? '');
onMounted(() => {
  void clusters.ensure();
  void store.load();
});

// ---- metrics export
const RANGES = [
  { id: '1d', seconds: 86_400 },
  { id: '7d', seconds: 7 * 86_400 },
  { id: '30d', seconds: 30 * 86_400 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];
const range = ref<RangeId>('1d');
const clusterId = ref<string | null>(null);
const clusterOptions = computed(() =>
  clusters.list.map((c) => ({
    value: c.id,
    label: c.name,
    description: t(`cloud.dataRights.kind.${c.kind === 'docker' ? 'docker' : 'kubernetes'}`),
  })),
);
watch(
  () => clusters.list,
  (list) => {
    if (!clusterId.value && list[0]) clusterId.value = list[0].id;
  },
  { immediate: true },
);
const metricsHref = computed(() => {
  if (!clusterId.value) return null;
  const to = Math.floor(Date.now() / 1000);
  const r = RANGES.find((x) => x.id === range.value)!;
  return exportUrls.metrics(clusterId.value, to - r.seconds, to);
});

// ---- deletion
const confirm = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const deletion = computed(() => store.status?.deletion ?? null);
const canDelete = computed(() => confirm.value.trim() === orgName.value.trim() && !busy.value);
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

async function requestDeletion() {
  error.value = null;
  busy.value = true;
  try {
    store.set(await cloudApi.requestDeletion(confirm.value));
    confirm.value = '';
  } catch (err) {
    error.value = t(cloudErrorKey(err));
  } finally {
    busy.value = false;
  }
}
async function undo() {
  error.value = null;
  busy.value = true;
  try {
    store.set(await cloudApi.undoDeletion());
  } catch (err) {
    error.value = t(cloudErrorKey(err));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex max-w-3xl flex-col gap-5" data-testid="data-settings">
    <p v-if="!isOwner" class="text-14 text-text-muted" data-testid="data-owners-only">
      {{ $t('cloud.dataRights.ownersOnly') }}
    </p>

    <section
      class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-4 md:p-5"
      aria-labelledby="export-title"
      data-testid="export-section"
    >
      <div class="flex flex-col gap-1">
        <h2 id="export-title" class="text-16 font-semibold text-text">
          {{ $t('cloud.dataRights.exportTitle') }}
        </h2>
        <p class="text-13 text-text-muted">{{ $t('cloud.dataRights.exportBody') }}</p>
      </div>

      <div class="flex flex-col gap-2 border-t border-border pt-4">
        <h3 class="text-14 font-semibold text-text">{{ $t('cloud.dataRights.configTitle') }}</h3>
        <p class="text-13 text-text-muted">{{ $t('cloud.dataRights.configBody') }}</p>
        <a
          v-if="isOwner"
          :href="exportUrls.config()"
          download
          class="inline-flex h-9 w-fit items-center gap-2 rounded-control border border-border bg-surface-2 px-3 text-13 font-medium text-text hover:bg-surface-3 max-sm:w-full max-sm:justify-center"
          data-testid="export-config"
        >
          <Download class="size-4" aria-hidden="true" />
          {{ $t('cloud.dataRights.configButton') }}
        </a>
      </div>

      <div class="flex flex-col gap-3 border-t border-border pt-4">
        <h3 class="text-14 font-semibold text-text">{{ $t('cloud.dataRights.metricsTitle') }}</h3>
        <p class="text-13 text-text-muted">{{ $t('cloud.dataRights.metricsBody') }}</p>
        <template v-if="isOwner">
          <p v-if="clusters.loaded && clusterOptions.length === 0" class="text-13 text-text-muted">
            {{ $t('cloud.dataRights.noClusters') }}
          </p>
          <div v-else class="flex flex-wrap items-end gap-3">
            <div class="flex min-w-0 flex-[1_1_220px] flex-col gap-1.5">
              <span class="text-12 text-text-muted">{{ $t('cloud.dataRights.cluster') }}</span>
              <ComboBox
                v-model="clusterId"
                :options="clusterOptions"
                :label="$t('cloud.dataRights.cluster')"
                data-testid="export-cluster"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <span class="text-12 text-text-muted">{{ $t('cloud.dataRights.range') }}</span>
              <div
                class="flex h-9 rounded-control border border-border bg-surface-2 p-0.5"
                role="radiogroup"
                :aria-label="$t('cloud.dataRights.range')"
              >
                <button
                  v-for="r in RANGES"
                  :key="r.id"
                  type="button"
                  role="radio"
                  :aria-checked="range === r.id"
                  :class="[
                    'rounded-[5px] px-3 text-13 transition-colors',
                    range === r.id ? 'bg-surface-3 text-text' : 'text-text-muted hover:text-text',
                  ]"
                  :data-testid="`export-range-${r.id}`"
                  @click="range = r.id"
                >
                  {{ $t(`cloud.dataRights.ranges.${r.id}`) }}
                </button>
              </div>
            </div>
            <a
              v-if="metricsHref"
              :href="metricsHref"
              download
              class="inline-flex h-9 items-center gap-2 rounded-control border border-border bg-surface-2 px-3 text-13 font-medium text-text hover:bg-surface-3 max-sm:w-full max-sm:justify-center"
              data-testid="export-metrics"
            >
              <Download class="size-4" aria-hidden="true" />
              {{ $t('cloud.dataRights.metricsButton') }}
            </a>
          </div>
          <p class="text-12 text-text-muted">{{ $t('cloud.dataRights.metricsNote') }}</p>
        </template>
      </div>
    </section>

    <section
      class="flex flex-col gap-4 rounded-card border border-critical/40 bg-surface-1 p-4 md:p-5"
      aria-labelledby="delete-title"
      data-testid="delete-section"
    >
      <div class="flex flex-col gap-1">
        <h2 id="delete-title" class="text-16 font-semibold text-text">
          {{ $t('cloud.dataRights.deleteTitle') }}
        </h2>
        <p class="text-13 text-text-muted">{{ $t('cloud.dataRights.deleteBody') }}</p>
      </div>

      <div
        v-if="deletion"
        class="flex flex-wrap items-center gap-3 rounded-control border border-critical/40 bg-critical/10 px-3 py-2.5"
        data-testid="deletion-scheduled"
      >
        <Trash2 class="size-4 shrink-0 text-critical" aria-hidden="true" />
        <p class="min-w-0 flex-1 text-13 text-text">
          {{
            $t('cloud.dataRights.scheduled', {
              date: day(deletion.dueAt),
              who: deletion.requestedBy ?? $t('cloud.dataRights.anOwner'),
            })
          }}
        </p>
        <BaseButton
          v-if="isOwner"
          variant="secondary"
          :loading="busy"
          class="max-sm:w-full"
          data-testid="deletion-undo"
          @click="undo"
        >
          {{ $t('cloud.dataRights.undo') }}
        </BaseButton>
      </div>

      <form
        v-else-if="isOwner"
        class="flex flex-col gap-3"
        data-testid="deletion-form"
        @submit.prevent="requestDeletion"
      >
        <TextField
          v-model="confirm"
          :label="$t('cloud.dataRights.confirmLabel', { name: orgName })"
          :placeholder="orgName"
          autocomplete="off"
          data-testid="deletion-confirm"
        />
        <BaseButton
          type="submit"
          variant="danger"
          :disabled="!canDelete"
          :loading="busy"
          class="w-fit max-sm:w-full"
          data-testid="deletion-submit"
        >
          {{ $t('cloud.dataRights.deleteButton') }}
        </BaseButton>
      </form>
      <p v-if="error" class="text-13 text-critical" role="alert">{{ error }}</p>
    </section>
  </div>
</template>
