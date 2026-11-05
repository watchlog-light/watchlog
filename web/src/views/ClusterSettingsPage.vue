<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowLeft, KeyRound } from '@lucide/vue';
import type { ClusterDetail, IssueTokenResponse } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api, ApiError, hasProblemType, ProblemType } from '@/api/client';
import TokenReveal from '@/components/clusters/TokenReveal.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import StatusPill from '@/components/ui/StatusPill.vue';
import { useLoader } from '@/composables/useLoader';
import { formatDateTime } from '@/lib/format';
import { useAuthStore } from '@/stores/auth';

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();
const canManage = auth.user?.role !== 'viewer';
const id = String(route.params.id);

const page = useLoader(() => api<ClusterDetail>(`/clusters/${id}`));
const detail = computed(() => page.data.value);
const notFound = computed(
  () => page.error.value instanceof ApiError && page.error.value.status === 404,
);
// Errors of the token actions; load errors come from the loader.
const error = ref<string>();
const issued = ref<IssueTokenResponse>();
const issuing = ref(false);
const confirmRevoke = ref<string>();
const revoking = ref<string>();

async function issueToken() {
  error.value = undefined;
  issuing.value = true;
  try {
    issued.value = await api<IssueTokenResponse>(`/clusters/${id}/tokens`, { method: 'POST' });
    await page.load();
  } catch (err) {
    error.value = hasProblemType(err, ProblemType.tokenLimit)
      ? t('clusters.errors.tokenLimit')
      : t('clusters.errors.generic');
  } finally {
    issuing.value = false;
  }
}

async function revoke(tokenId: string) {
  error.value = undefined;
  revoking.value = tokenId;
  try {
    await api<void>(`/clusters/${id}/tokens/${tokenId}`, { method: 'DELETE' });
    confirmRevoke.value = undefined;
    await page.load();
  } catch {
    error.value = t('clusters.errors.generic');
  } finally {
    revoking.value = undefined;
  }
}

onMounted(page.load);
</script>

<template>
  <div class="mx-auto flex max-w-3xl flex-col gap-6">
    <RouterLink
      :to="{ name: 'settings' }"
      class="inline-flex items-center gap-1.5 self-start text-13 text-text-muted hover:text-text"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />
      {{ $t('clusters.back') }}
    </RouterLink>

    <p v-if="notFound" class="text-14 text-text-muted">{{ $t('clusters.errors.notFound') }}</p>
    <ErrorState
      v-else-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('clusters.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />

    <template v-if="page.skeleton.value">
      <SkeletonDetailHeader :label="$t('common.loading')" />
      <section class="rounded-card border border-border bg-surface-1" aria-hidden="true">
        <div class="border-b border-border px-5 py-4">
          <Skeleton class="w-24 text-14" />
          <Skeleton class="mt-1 w-80 text-13" />
        </div>
        <div
          v-for="i in 2"
          :key="i"
          class="flex items-center gap-4 border-b border-border px-5 py-3 last:border-b-0"
        >
          <Skeleton shape="rect" class="size-4 shrink-0" />
          <div class="flex-1">
            <Skeleton class="w-36 font-mono text-13" />
            <Skeleton class="w-48 text-12" />
          </div>
        </div>
      </section>
    </template>

    <template v-else-if="detail">
      <header class="flex items-center justify-between gap-4">
        <div>
          <h2 class="flex items-center gap-2 text-20 font-semibold text-text">
            {{ detail.cluster.name }}
            <LoadingIndicator :active="page.refreshing.value" />
          </h2>
          <p class="mt-1 text-13 text-text-muted">
            {{ $t(`clusters.kind.${detail.cluster.kind}`) }} ·
            {{
              $t(
                detail.cluster.kind === 'kubernetes' ? 'clusters.nodes' : 'clusters.hosts',
                { n: detail.cluster.nodeCount },
                detail.cluster.nodeCount,
              )
            }}
          </p>
        </div>
        <StatusPill :status="detail.cluster.status" />
      </header>

      <TokenReveal
        v-if="issued"
        :token="issued.token.value"
        :install="issued.install"
        rotation
        @done="issued = undefined"
      />

      <p v-if="error" role="alert" class="text-13 text-critical">{{ error }}</p>

      <section class="rounded-card border border-border bg-surface-1">
        <div class="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h3 class="text-14 font-semibold text-text">{{ $t('clusters.tokens.title') }}</h3>
            <p class="mt-1 text-13 text-text-muted">{{ $t('clusters.tokens.intro') }}</p>
          </div>
          <BaseButton
            v-if="canManage"
            variant="secondary"
            data-testid="issue-token"
            :loading="issuing"
            @click="issueToken"
          >
            {{ $t('clusters.tokens.issue') }}
          </BaseButton>
        </div>
        <ul data-testid="token-list">
          <li
            v-for="token in detail.tokens"
            :key="token.id"
            class="flex items-center gap-4 border-b border-border px-5 py-3 last:border-b-0"
          >
            <KeyRound class="size-4 shrink-0 text-text-muted" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <p class="font-mono text-13 text-text">wl_ct_{{ token.prefix }}…</p>
              <p class="text-12 text-text-muted">
                {{ $t('clusters.tokens.created', { at: formatDateTime(token.createdAt) }) }}
                <template v-if="token.revokedAt">
                  · {{ $t('clusters.tokens.revokedAt', { at: formatDateTime(token.revokedAt) }) }}
                </template>
              </p>
            </div>
            <span v-if="token.revokedAt" class="text-12 text-text-muted">
              {{ $t('clusters.tokens.revoked') }}
            </span>
            <template v-else-if="canManage">
              <template v-if="confirmRevoke === token.id">
                <BaseButton
                  variant="danger"
                  data-testid="confirm-revoke"
                  :loading="revoking === token.id"
                  @click="revoke(token.id)"
                >
                  {{ $t('clusters.tokens.confirmRevoke') }}
                </BaseButton>
                <BaseButton variant="ghost" @click="confirmRevoke = undefined">
                  {{ $t('common.cancel') }}
                </BaseButton>
              </template>
              <BaseButton
                v-else
                variant="ghost"
                data-testid="revoke"
                @click="confirmRevoke = token.id"
              >
                {{ $t('clusters.tokens.revoke') }}
              </BaseButton>
            </template>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
