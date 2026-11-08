<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { KeyRound, Lock, Plus } from '@lucide/vue';
import type { ApiToken, ApiTokenList } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import ApiTokenBadge from '@/components/settings/ApiTokenBadge.vue';
import ApiTokenCreate from '@/components/settings/ApiTokenCreate.vue';
import ApiTokenRevoke from '@/components/settings/ApiTokenRevoke.vue';
import ApiTokensDemo from '@/components/settings/ApiTokensDemo.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useApiTokenText } from '@/composables/useApiTokenText';
import { useLoader } from '@/composables/useLoader';
import { useNarrow } from '@/composables/useNarrow';
import { baseUrl, canRevoke, isDone, lastPlace } from '@/lib/api-tokens';
import { LINKS } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';
import { useServerSettingsStore } from '@/stores/serverSettings';

// Settings → API tokens (ADR-125): each user's own read-only tokens for the REST API and
// MCP. Every role may have them; they read only what the user can read. The read-only
// demo shows its public token instead (ADR-130).
const auth = useAuthStore();
const settings = useServerSettingsStore();
const narrow = useNarrow();
const text = useApiTokenText();

const list = useLoader(async () => (await api<ApiTokenList>('/api-tokens')).tokens);
const tokens = computed<ApiToken[]>(() => list.data.value ?? []);
const url = computed(() => baseUrl(settings.general?.publicUrl, window.location.origin));

const creating = ref(false);
const revoking = ref<ApiToken | null>(null);
const revokeOpen = computed({
  get: () => revoking.value !== null,
  set: (v) => {
    if (!v) revoking.value = null;
  },
});

const detailLink = (tk: ApiToken) => ({ name: 'api-token', params: { id: tk.id } });

onMounted(() => {
  if (auth.demoMode) return;
  void list.load();
  if (!settings.general) void settings.loadGeneral().catch(() => {});
});
</script>

<template>
  <ApiTokensDemo v-if="auth.demoMode" />
  <section v-else class="flex flex-col gap-5" data-testid="api-tokens">
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div class="flex max-w-160 flex-col gap-2">
        <h2 class="flex items-center gap-2 text-20 font-semibold text-text">
          {{ $t('apiTokens.title') }}
          <LoadingIndicator :active="list.refreshing.value" />
        </h2>
        <p class="text-14 leading-relaxed text-text-muted">{{ $t('apiTokens.intro') }}</p>
        <ul class="flex flex-wrap gap-1.5">
          <li
            v-for="chip in ['readOnly', 'restAndMcp', 'bothKinds'] as const"
            :key="chip"
            class="inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2.5 text-12 text-text-muted"
          >
            <Lock v-if="chip === 'readOnly'" class="size-3" aria-hidden="true" />
            {{ $t(`apiTokens.chips.${chip}`) }}
          </li>
        </ul>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <a
          :href="LINKS.mcp"
          target="_blank"
          rel="noopener"
          class="inline-flex min-h-11 items-center px-1.5 text-13 text-primary hover:underline lg:min-h-9"
          >{{ $t('apiTokens.guide') }}</a
        >
        <BaseButton
          v-if="list.loaded.value"
          data-testid="api-token-create"
          @click="creating = true"
        >
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('apiTokens.create.open') }}
        </BaseButton>
      </div>
    </header>

    <ErrorState
      v-if="list.error.value"
      :inline="list.loaded.value"
      :message="$t('apiTokens.loadFailed')"
      :retrying="list.loading.value"
      @retry="list.load"
    />
    <SkeletonTable
      v-if="list.skeleton.value"
      :rows="3"
      :columns="6"
      :label="$t('common.loading')"
    />

    <div
      v-else-if="list.loaded.value && tokens.length === 0"
      class="flex flex-col items-center gap-3 rounded-card border border-dashed border-border-strong px-6 py-12 text-center"
      data-testid="api-tokens-empty"
    >
      <span
        class="flex size-11 items-center justify-center rounded-card border border-border bg-surface-2 text-text-muted"
        aria-hidden="true"
      >
        <KeyRound class="size-5" />
      </span>
      <h3 class="text-16 font-semibold text-text">{{ $t('apiTokens.empty.title') }}</h3>
      <p class="max-w-110 text-14 leading-relaxed text-text-muted">
        {{ $t('apiTokens.empty.text') }}
      </p>
      <BaseButton class="mt-1.5" data-testid="api-token-create-first" @click="creating = true">
        {{ $t('apiTokens.empty.action') }}
      </BaseButton>
    </div>

    <!-- Phones: one card per token. -->
    <ul
      v-else-if="tokens.length > 0 && narrow"
      class="flex flex-col gap-2.5"
      data-testid="api-token-cards"
    >
      <li
        v-for="tk in tokens"
        :key="tk.id"
        class="flex flex-col gap-2 rounded-card border border-border bg-surface-1 p-3.5"
      >
        <div class="flex items-center justify-between gap-2">
          <RouterLink
            :to="detailLink(tk)"
            :class="[
              'flex min-h-11 min-w-11 items-center text-14 font-semibold wrap-anywhere',
              isDone(tk) ? 'text-text-muted' : 'text-text',
            ]"
            >{{ tk.name }}</RouterLink
          >
          <ApiTokenBadge :status="tk.status" />
        </div>
        <span class="font-mono text-12 text-text-muted"
          >{{ tk.prefix }}…<template v-if="tk.mcpCalls30d > 0 || tk.usedRest">
            · {{ text.calls(tk) }}</template
          ></span
        >
        <span class="text-13 text-text-muted">
          {{ $t('apiTokens.card.expires', { date: text.expires(tk) }) }} ·
          <span :class="text.note(tk).warn ? 'text-warning' : ''">{{ text.note(tk).text }}</span>
        </span>
        <span class="text-13 text-text-muted">
          {{ $t('apiTokens.card.lastUsed', { when: text.lastUsed(tk) })
          }}<template v-if="lastPlace(tk)"> · {{ lastPlace(tk) }}</template>
        </span>
        <div class="mt-0.5 flex gap-2">
          <RouterLink
            :to="detailLink(tk)"
            class="flex h-11 flex-1 items-center justify-center rounded-control border border-border bg-surface-2 text-14 font-medium text-text"
            >{{ $t('apiTokens.activity') }}</RouterLink
          >
          <button
            v-if="canRevoke(tk)"
            type="button"
            class="h-11 flex-1 rounded-control border border-critical/40 text-14 font-medium text-critical"
            data-testid="api-token-revoke"
            @click="revoking = tk"
          >
            {{ $t('apiTokens.revoke.open') }}
          </button>
        </div>
      </li>
    </ul>

    <!-- Tablets and wider: a table. Below 1280 px the Token column and the Activity button
         (the name links to the same page) step aside, so Revoke stays in view. -->
    <div
      v-else-if="tokens.length > 0"
      class="overflow-x-auto rounded-card border border-border bg-surface-1"
      data-testid="api-token-table"
    >
      <table class="w-full border-collapse text-13 xl:min-w-215">
        <thead>
          <tr class="text-left text-11 tracking-wider text-text-muted uppercase">
            <th class="px-4.5 py-3 font-medium">{{ $t('apiTokens.columns.name') }}</th>
            <th class="p-3 font-medium max-xl:hidden">{{ $t('apiTokens.columns.token') }}</th>
            <th class="p-3 font-medium">{{ $t('apiTokens.columns.expires') }}</th>
            <th class="p-3 font-medium">{{ $t('apiTokens.columns.lastUsed') }}</th>
            <th class="p-3 font-medium">{{ $t('apiTokens.columns.calls') }}</th>
            <th class="p-3 font-medium">{{ $t('apiTokens.columns.status') }}</th>
            <th class="px-4.5 py-3">
              <span class="sr-only">{{ $t('apiTokens.columns.actions') }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="tk in tokens"
            :key="tk.id"
            class="border-t border-surface-3"
            :data-token="tk.prefix"
          >
            <td class="px-4.5 py-2.5">
              <RouterLink
                :to="detailLink(tk)"
                :class="[
                  'inline-flex min-h-9 min-w-11 items-center text-14 font-medium hover:underline max-lg:min-h-11',
                  isDone(tk) ? 'text-text-muted' : 'text-text',
                ]"
                >{{ tk.name }}</RouterLink
              >
            </td>
            <td class="p-3 font-mono text-12 whitespace-nowrap text-text-muted max-xl:hidden">
              {{ tk.prefix }}…
            </td>
            <td class="p-3 whitespace-nowrap">
              <span class="block text-text">{{ text.expires(tk) }}</span>
              <span :class="['text-12', text.note(tk).warn ? 'text-warning' : 'text-text-muted']">{{
                text.note(tk).text
              }}</span>
            </td>
            <td class="p-3 whitespace-nowrap">
              <span class="block text-text">{{ text.lastUsed(tk) }}</span>
              <span v-if="lastPlace(tk)" class="font-mono text-12 text-text-muted">{{
                lastPlace(tk)
              }}</span>
            </td>
            <td class="p-3 font-mono text-12 whitespace-nowrap text-text-muted">
              {{ text.calls(tk) }}
            </td>
            <td class="p-3"><ApiTokenBadge :status="tk.status" /></td>
            <td class="px-4.5 py-2.5 text-right whitespace-nowrap">
              <RouterLink
                :to="detailLink(tk)"
                class="inline-flex h-9 items-center rounded-control border border-border px-2.5 text-13 text-text hover:bg-surface-2 max-xl:hidden"
                >{{ $t('apiTokens.activity') }}</RouterLink
              >
              <button
                v-if="canRevoke(tk)"
                type="button"
                class="ml-1.5 h-9 rounded-control px-2.5 text-13 text-critical hover:bg-surface-2 max-lg:h-11"
                data-testid="api-token-revoke"
                @click="revoking = tk"
              >
                {{ $t('apiTokens.revoke.open') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="tokens.length > 0" class="text-12 leading-relaxed text-text-muted">
      {{ $t('apiTokens.footnote') }}
    </p>

    <ApiTokenCreate v-model:open="creating" :base-url="url" @created="list.load" />
    <ApiTokenRevoke v-model:open="revokeOpen" :token="revoking" @revoked="list.load" />
  </section>
</template>
