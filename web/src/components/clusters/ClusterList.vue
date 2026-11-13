<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import LockedControl from '@/components/ui/LockedControl.vue';
import { ChevronRight, Container, Plus } from '@lucide/vue';
import { KIND_LOGO } from '@/components/ui/kindLogos';
import type { Cluster, ClusterList, CreateClusterResponse } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useClustersStore } from '@/stores/clusters';
import { api, ApiError, hasProblemType, ProblemType } from '@/api/client';
import TokenReveal from '@/components/clusters/TokenReveal.vue';
import LiveChecklist from '@/components/onboarding/LiveChecklist.vue';
import { useOnboardingStatus } from '@/composables/useOnboardingStatus';
import BaseButton from '@/components/ui/BaseButton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import StatusPill from '@/components/ui/StatusPill.vue';
import TextField from '@/components/ui/TextField.vue';
import { useLoader } from '@/composables/useLoader';
import { formatDateTime } from '@/lib/format';
import { useAuthStore } from '@/stores/auth';

const { t } = useI18n();
const auth = useAuthStore();
const canManage = auth.canManage;

const selection = useClustersStore();
const list = useLoader(async () => (await api<ClusterList>('/clusters')).clusters);
const clusters = computed<Cluster[]>(() => list.data.value ?? []);

const creating = ref(false);
const name = ref('my-cluster');
const kind = ref<'docker' | 'kubernetes'>('docker');
const createError = ref<string>();
const submitting = ref(false);
const revealed = ref<CreateClusterResponse>();
/** The new cluster's live connection checklist under its install command (ADR-176). */
const watching = ref<{ id: string; kind: 'docker' | 'kubernetes' } | null>(null);
const { status } = useOnboardingStatus(computed(() => watching.value?.id ?? null));

function createErrorMessage(err: unknown): string {
  if (hasProblemType(err, ProblemType.nameTaken)) return t('clusters.errors.nameTaken');
  if (err instanceof ApiError && err.status === 400) return t('clusters.errors.invalidName');
  return t('clusters.errors.generic');
}

async function create() {
  createError.value = undefined;
  submitting.value = true;
  try {
    revealed.value = await api<CreateClusterResponse>('/clusters', {
      method: 'POST',
      body: { name: name.value.trim(), kind: kind.value },
    });
    watching.value = { id: revealed.value.cluster.id, kind: revealed.value.cluster.kind };
    creating.value = false;
    // The switcher lists the new cluster; the selection stays as it is.
    await Promise.all([list.load(), selection.load()]);
  } catch (err) {
    createError.value = createErrorMessage(err);
  } finally {
    submitting.value = false;
  }
}

onMounted(list.load);
</script>

<template>
  <div class="flex flex-col gap-6">
    <header class="flex items-end justify-between gap-4">
      <div>
        <h2 class="flex items-center gap-2 text-20 font-semibold text-text">
          {{ $t('clusters.title') }}
          <LoadingIndicator :active="list.refreshing.value" />
        </h2>
        <p class="mt-1 text-14 text-text-muted">{{ $t('clusters.intro') }}</p>
      </div>
      <LockedControl v-if="clusters.length > 0 && !creating && !revealed" align="end">
        <BaseButton variant="secondary" data-testid="add-cluster" @click="creating = true">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('clusters.add') }}
        </BaseButton>
      </LockedControl>
    </header>

    <TokenReveal
      v-if="revealed"
      :token="revealed.token.value"
      :install="revealed.install"
      @done="revealed = undefined"
    />
    <div
      v-if="watching"
      class="rounded-card border border-border bg-surface-1 p-5"
      data-testid="add-cluster-checklist"
    >
      <LiveChecklist :status="status" :kind="watching.kind" />
      <div v-if="!revealed" class="mt-4 flex justify-end">
        <BaseButton variant="ghost" @click="watching = null">{{ $t('common.close') }}</BaseButton>
      </div>
    </div>

    <form
      v-if="creating"
      data-testid="create-form"
      class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-5"
      novalidate
      @submit.prevent="create"
    >
      <h3 class="text-14 font-semibold text-text">{{ $t('clusters.create.title') }}</h3>
      <fieldset class="flex flex-col gap-1.5">
        <legend class="mb-1.5 text-13 font-medium text-text">
          {{ $t('clusters.create.kind') }}
        </legend>
        <div class="flex flex-wrap gap-2" data-testid="kind-choice">
          <label
            v-for="k in ['docker', 'kubernetes'] as const"
            :key="k"
            :class="[
              'flex cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-13 max-lg:min-h-11',
              kind === k
                ? 'border-primary bg-primary-soft text-text'
                : 'border-border text-text-muted hover:bg-surface-2',
            ]"
          >
            <input v-model="kind" type="radio" name="kind" :value="k" class="accent-primary" />
            <component :is="KIND_LOGO[k]" class="size-4 shrink-0" aria-hidden="true" />
            {{ $t(`clusters.kind.${k}`) }}
          </label>
        </div>
      </fieldset>
      <TextField
        v-model="name"
        :label="$t('clusters.create.name')"
        :hint="$t('clusters.create.nameHint')"
        :error="createError"
        required
        :maxlength="63"
      />
      <div class="flex gap-2">
        <BaseButton type="submit" :loading="submitting">{{
          $t('clusters.create.submit')
        }}</BaseButton>
        <BaseButton variant="ghost" @click="creating = false">{{ $t('common.cancel') }}</BaseButton>
      </div>
    </form>

    <ErrorState
      v-if="list.error.value"
      :inline="list.loaded.value"
      :message="$t('clusters.errors.load')"
      :retrying="list.loading.value"
      @retry="list.load"
    />

    <ul
      v-if="list.skeleton.value"
      class="flex flex-col gap-2"
      role="status"
      :aria-label="$t('common.loading')"
      data-testid="cluster-list-skeleton"
    >
      <li
        v-for="i in 2"
        :key="i"
        class="flex items-center gap-4 rounded-card border border-border bg-surface-1 px-4 py-3"
      >
        <Skeleton shape="rect" class="size-5 shrink-0" />
        <div class="min-w-0 flex-1">
          <Skeleton class="w-32 text-14" />
          <Skeleton class="w-64 text-12" />
        </div>
        <span class="block rounded-full border border-transparent px-2 py-0.5 text-12">
          <Skeleton class="w-14" />
        </span>
        <span class="size-4 shrink-0" />
      </li>
    </ul>

    <EmptyState
      v-else-if="list.loaded.value && clusters.length === 0 && !creating && !revealed"
      :icon="Container"
      :title="$t('clusters.empty.title')"
      :description="$t('clusters.empty.description')"
    >
      <template v-if="canManage" #action>
        <BaseButton data-testid="add-first-cluster" @click="creating = true">
          {{ $t('clusters.empty.action') }}
        </BaseButton>
      </template>
    </EmptyState>

    <ul v-else-if="clusters.length > 0" class="flex flex-col gap-2" data-testid="cluster-list">
      <li v-for="cluster in clusters" :key="cluster.id">
        <RouterLink
          :to="{ name: 'cluster-settings', params: { id: cluster.id } }"
          class="flex items-center gap-4 rounded-card border border-border bg-surface-1 px-4 py-3 transition-colors hover:bg-surface-2"
        >
          <component :is="KIND_LOGO[cluster.kind]" class="size-5 shrink-0" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-14 font-medium text-text">{{ cluster.name }}</p>
            <p class="text-12 text-text-muted">
              {{ $t(`clusters.kind.${cluster.kind}`) }} ·
              {{
                $t(
                  cluster.kind === 'kubernetes' ? 'clusters.nodes' : 'clusters.hosts',
                  { n: cluster.nodeCount },
                  cluster.nodeCount,
                )
              }}
              ·
              {{
                cluster.lastSeenAt
                  ? $t('clusters.lastSeen', { at: formatDateTime(cluster.lastSeenAt) })
                  : $t('clusters.neverSeen')
              }}
            </p>
            <p
              v-if="cluster.ingestFailure"
              class="text-12 text-critical"
              data-testid="cluster-ingest-failing"
            >
              {{
                $t('clusters.ingest.short', {
                  since: formatDateTime(cluster.ingestFailure.since),
                })
              }}
            </p>
          </div>
          <StatusPill :status="cluster.status" />
          <ChevronRight class="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
        </RouterLink>
      </li>
    </ul>
  </div>
</template>
