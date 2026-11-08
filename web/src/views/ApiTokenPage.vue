<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue';
import type { ApiTokenDetail, ApiTokenEvent } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api, ApiError } from '@/api/client';
import ApiTokenBadge from '@/components/settings/ApiTokenBadge.vue';
import ApiTokenRevoke from '@/components/settings/ApiTokenRevoke.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import { useApiTokenText } from '@/composables/useApiTokenText';
import { useLoader } from '@/composables/useLoader';
import { useNarrow } from '@/composables/useNarrow';
import { CALL_TONE, canRevoke, EVENT_DOT, formatDay, mcpCalls } from '@/lib/api-tokens';
import { formatDateTime, formatWhen } from '@/lib/format';
import { formatBytes } from '@/lib/units';
import { useAuthStore } from '@/stores/auth';

// One API token (ADR-125): its history (created, first use, a new address, the expiry
// reminder, expired or revoked) and its MCP tool calls, the last 50, never their output.
const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();
const narrow = useNarrow();
const text = useApiTokenText();
const id = String(route.params.id);

const page = useLoader(() => api<ApiTokenDetail>(`/api-tokens/${id}`));
const token = computed(() => page.data.value?.token);
const calls = computed(() => (page.data.value ? mcpCalls(page.data.value) : []));
const notFound = computed(
  () =>
    page.error.value instanceof ApiError &&
    (page.error.value.status === 404 || page.error.value.status === 400),
);
const revokeOpen = ref(false);
const back = { name: 'settings', query: { tab: 'tokens' } };

const place = (e: ApiTokenEvent) =>
  e.ip ? (e.country ? `${e.ip} (${e.country})` : e.ip) : t('apiTokens.history.unknownPlace');
const who = (e: ApiTokenEvent) =>
  !e.by || e.by.id === auth.user?.id ? t('apiTokens.history.you') : e.by.name;

function eventLabel(e: ApiTokenEvent): string {
  switch (e.kind) {
    case 'created':
      return e.expiresAt
        ? t('apiTokens.history.created', { who: who(e), date: formatDay(e.expiresAt) })
        : t('apiTokens.history.createdNever', { who: who(e) });
    case 'first_use':
      return t('apiTokens.history.firstUse', { place: place(e) });
    case 'new_ip':
      return t('apiTokens.history.newIp', { place: place(e) });
    case 'expired':
      return t('apiTokens.history.expired');
    case 'revoked':
      return t('apiTokens.history.revoked', { who: who(e) });
    case 'reminder_sent':
      return t('apiTokens.history.reminder');
  }
}

onMounted(page.load);
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-5" data-testid="api-token-page">
    <RouterLink
      :to="back"
      class="inline-flex min-h-10 items-center gap-1.5 self-start text-13 text-text-muted hover:text-text max-lg:min-h-11"
    >
      <ArrowLeft class="size-3.5" aria-hidden="true" />
      {{ $t('apiTokens.title') }}
    </RouterLink>

    <ErrorState
      v-if="page.error.value && !notFound"
      :inline="page.loaded.value"
      :message="$t('apiTokens.loadOneFailed')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <p v-if="notFound" class="text-14 text-text-muted" data-testid="api-token-not-found">
      {{ $t('apiTokens.notFound') }}
    </p>
    <SkeletonDetailHeader v-if="page.skeleton.value" :label="$t('common.loading')" />

    <template v-if="token">
      <header class="flex flex-wrap items-start justify-between gap-3.5">
        <div class="flex min-w-0 flex-col gap-2">
          <div class="flex flex-wrap items-center gap-2.5">
            <h2 class="text-20 font-semibold wrap-anywhere text-text">{{ token.name }}</h2>
            <ApiTokenBadge :status="token.status" />
            <LoadingIndicator :active="page.refreshing.value" />
          </div>
          <p class="text-13 text-text-muted">
            <span class="font-mono">{{ token.prefix }}…</span> ·
            {{
              $t('apiTokens.detail.meta', {
                created: formatDay(token.createdAt),
                expires: text.expires(token),
              })
            }}
          </p>
        </div>
        <button
          v-if="canRevoke(token)"
          type="button"
          class="h-10 rounded-control border border-critical/40 px-3.5 text-14 font-medium text-critical hover:bg-surface-2 max-lg:h-11"
          data-testid="api-token-revoke"
          @click="revokeOpen = true"
        >
          {{ $t('apiTokens.revoke.openLong') }}
        </button>
      </header>

      <div class="flex flex-wrap items-start gap-4">
        <section
          class="flex min-w-0 flex-[1_1_300px] flex-col gap-3 rounded-card border border-border bg-surface-1 p-4.5"
          data-testid="api-token-history"
        >
          <h3 class="text-14 font-semibold text-text">{{ $t('apiTokens.history.title') }}</h3>
          <ol class="flex flex-col">
            <li
              v-for="(e, i) in page.data.value!.history"
              :key="i"
              class="grid grid-cols-[14px_minmax(0,1fr)] gap-2.5 border-t border-surface-3 py-2"
              :data-kind="e.kind"
            >
              <span :class="['mt-1 size-2.5 rounded-full', EVENT_DOT[e.kind]]" aria-hidden="true" />
              <span class="flex flex-col gap-0.5">
                <span
                  :class="[
                    'text-13 wrap-anywhere',
                    e.kind === 'new_ip' ? 'text-warning' : 'text-text',
                  ]"
                  >{{ eventLabel(e) }}</span
                >
                <time class="font-mono text-12 text-text-muted" :datetime="e.at">{{
                  formatDateTime(e.at)
                }}</time>
              </span>
            </li>
          </ol>
        </section>

        <section
          class="flex min-w-0 flex-[999_1_560px] flex-col rounded-card border border-border bg-surface-1"
          data-testid="api-token-activity"
        >
          <div
            class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4.5 py-4"
          >
            <h3 class="text-14 font-semibold text-text">{{ $t('apiTokens.mcp.title') }}</h3>
            <span class="text-12 text-text-muted">{{ $t('apiTokens.mcp.note') }}</span>
          </div>
          <p v-if="calls.length === 0" class="px-4.5 py-7 text-center text-14 text-text-muted">
            {{ token.usedRest ? $t('apiTokens.mcp.restOnly') : $t('apiTokens.mcp.none') }}
          </p>
          <ul v-else-if="narrow" class="flex flex-col" data-testid="api-token-calls">
            <li
              v-for="(c, i) in calls"
              :key="i"
              class="flex flex-col gap-1 border-t border-surface-3 px-4 py-3 first:border-t-0"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="font-mono text-13 font-medium text-text">{{ c.tool }}</span>
                <span :class="['text-12 font-medium', CALL_TONE[c.status]]">{{
                  $t(`apiTokens.mcp.status.${c.status}`)
                }}</span>
              </div>
              <span class="text-13 wrap-anywhere text-text-muted">{{ c.args }}</span>
              <span class="font-mono text-12 text-text-muted"
                >{{ formatWhen(c.at) }} · {{ $t('apiTokens.mcp.ms', { n: c.durationMs }) }} ·
                {{ formatBytes(c.bytes) }}</span
              >
            </li>
          </ul>
          <div v-else class="overflow-x-auto" data-testid="api-token-calls">
            <table class="w-full min-w-175 border-collapse text-13">
              <thead>
                <tr class="text-left text-11 tracking-wider text-text-muted uppercase">
                  <th class="px-4.5 py-2.5 font-medium">{{ $t('apiTokens.mcp.columns.time') }}</th>
                  <th class="px-3 py-2.5 font-medium">{{ $t('apiTokens.mcp.columns.tool') }}</th>
                  <th class="px-3 py-2.5 font-medium">{{ $t('apiTokens.mcp.columns.args') }}</th>
                  <th class="px-3 py-2.5 font-medium">{{ $t('apiTokens.mcp.columns.status') }}</th>
                  <th class="px-3 py-2.5 text-right font-medium">
                    {{ $t('apiTokens.mcp.columns.duration') }}
                  </th>
                  <th class="px-4.5 py-2.5 text-right font-medium">
                    {{ $t('apiTokens.mcp.columns.size') }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(c, i) in calls" :key="i" class="border-t border-surface-3">
                  <td class="px-4.5 py-2.5 font-mono text-12 whitespace-nowrap text-text-muted">
                    {{ formatWhen(c.at) }}
                  </td>
                  <td class="px-3 py-2.5 font-mono text-12 whitespace-nowrap text-text">
                    {{ c.tool }}
                  </td>
                  <td class="px-3 py-2.5 text-text-muted">{{ c.args }}</td>
                  <td
                    :class="[
                      'px-3 py-2.5 text-12 font-medium whitespace-nowrap',
                      CALL_TONE[c.status],
                    ]"
                  >
                    {{ $t(`apiTokens.mcp.status.${c.status}`) }}
                  </td>
                  <td class="px-3 py-2.5 text-right font-mono text-12 text-text-muted">
                    {{ $t('apiTokens.mcp.ms', { n: c.durationMs }) }}
                  </td>
                  <td class="px-4.5 py-2.5 text-right font-mono text-12 text-text-muted">
                    {{ formatBytes(c.bytes) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <ApiTokenRevoke v-model:open="revokeOpen" :token="token" @revoked="page.load" />
    </template>
  </div>
</template>
