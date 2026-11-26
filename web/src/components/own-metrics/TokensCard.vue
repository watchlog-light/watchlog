<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// The write-only tokens of own metrics (1.0.0, ADR-236): for Prometheus remote write, pushes
// and change events. A token's value is shown once, when it is made, and handed to the page
// so its snippets carry it.
import type { OwnMetricsSummary, OwnMetricToken } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '@/api/client';
import { ownMetricsApi } from '@/api/own-metrics';
import BaseButton from '@/components/ui/BaseButton.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import TextField from '@/components/ui/TextField.vue';
import { agoShort } from '@/lib/format';
import { useAuthStore } from '@/stores/auth';

const props = defineProps<{ cluster: string; summary: OwnMetricsSummary }>();
const emit = defineEmits<{ changed: []; made: [value: string] }>();
const { t } = useI18n();
const auth = useAuthStore();

const name = ref('');
const error = ref('');
const making = ref(false);
const made = ref<{ name: string; value: string } | null>(null);

async function create() {
  error.value = '';
  if (!name.value.trim()) {
    error.value = t('ownMetrics.tokens.nameNeeded');
    return;
  }
  making.value = true;
  try {
    const res = await ownMetricsApi.createToken(props.cluster, name.value.trim());
    made.value = { name: res.name, value: res.value };
    name.value = '';
    emit('made', res.value);
    emit('changed');
  } catch (err) {
    error.value = (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.tokens.failed');
  } finally {
    making.value = false;
  }
}

const revoking = ref<OwnMetricToken | null>(null);
const open = computed({
  get: () => revoking.value !== null,
  set: (v) => {
    if (!v) revoking.value = null;
  },
});
async function revoke() {
  await ownMetricsApi.revokeToken(props.cluster, revoking.value!.id);
  emit('changed');
}
</script>

<template>
  <section
    class="rounded-card border border-border bg-surface-1 px-5 py-4"
    data-testid="own-tokens"
  >
    <h3 class="text-14 font-semibold text-text">{{ $t('ownMetrics.tokens.title') }}</h3>
    <p class="mt-1 text-13 leading-relaxed text-text-muted">{{ $t('ownMetrics.tokens.about') }}</p>

    <div
      v-if="made"
      class="mt-3 rounded-card border border-warning/40 bg-warning/10 px-4 py-3"
      role="status"
      data-testid="own-token-made"
    >
      <p class="text-14 text-text">{{ $t('ownMetrics.tokens.once', { name: made.name }) }}</p>
      <CodeBlock class="mt-2" :code="made.value" :label="$t('ownMetrics.tokens.value')" wrap />
    </div>

    <ul v-if="summary.tokens.length" class="mt-3 divide-y divide-border">
      <li
        v-for="k in summary.tokens"
        :key="k.id"
        class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-14"
        data-testid="own-token"
      >
        <span class="min-w-0 flex-1 truncate text-text">{{ k.name }}</span>
        <span class="font-mono text-12 text-text-subtle">wl_mt_{{ k.prefix }}…</span>
        <span class="text-13 text-text-muted">
          {{
            k.lastUsedAt
              ? $t('ownMetrics.tokens.used', { ago: agoShort(k.lastUsedAt / 1000) })
              : $t('ownMetrics.tokens.neverUsed')
          }}
        </span>
        <button
          v-if="auth.canManage"
          type="button"
          class="text-13 text-link hover:underline max-lg:min-h-11"
          data-testid="own-token-revoke"
          @click="revoking = k"
        >
          {{ $t('ownMetrics.tokens.revoke') }}
        </button>
      </li>
    </ul>

    <form
      v-if="auth.canManage"
      class="mt-3 flex flex-wrap items-end gap-2"
      data-testid="own-token-form"
      @submit.prevent="create"
    >
      <TextField
        v-model="name"
        class="min-w-52 flex-1"
        :label="$t('ownMetrics.tokens.name')"
        :placeholder="$t('ownMetrics.tokens.namePlaceholder')"
        :error="error"
        :maxlength="64"
      />
      <BaseButton
        type="submit"
        variant="secondary"
        :loading="making"
        data-testid="own-token-create"
      >
        {{ $t('ownMetrics.tokens.create') }}
      </BaseButton>
    </form>
    <p v-else class="mt-3 text-13 text-text-subtle">{{ $t('ownMetrics.tokens.viewer') }}</p>

    <ConfirmDialog
      v-model:open="open"
      :title="$t('ownMetrics.tokens.revokeTitle')"
      :subject="revoking?.name"
      :lines="[$t('ownMetrics.tokens.revokeBody')]"
      :confirm-label="$t('ownMetrics.tokens.revoke')"
      :action="revoke"
      testid="own-token-confirm"
    />
  </section>
</template>
