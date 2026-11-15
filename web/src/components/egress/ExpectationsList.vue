<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { BadgeCheck, CircleAlert } from '@lucide/vue';
import type { EgressExpectation, EgressExpectations } from '@watchlog/api-types';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import { useLoader } from '@/composables/useLoader';
import { ago, sourceName } from '@/lib/egress';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';

// The cluster's or fleet's expected destinations (ADR-186) on the Egress page: each pattern,
// its port (or any), its source (or every workload / container), who marked it and how many
// destinations it covers now, with Remove; and a pattern added for every source, which covers
// destinations not seen yet. Owners and Admins change it; everyone reads it.
const props = defineProps<{
  clusterId: string;
  kind: 'kubernetes' | 'docker';
  /** Bumped by the page when a row's "Mark expected" or "Undo" changed the list. */
  version?: number;
  now?: number;
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();

const list = useLoader(() =>
  api<EgressExpectations>(`/egress/expected?cluster=${encodeURIComponent(props.clusterId)}`),
);
onMounted(list.load);
watch(
  () => [props.clusterId, props.version],
  () => void list.load(),
);
const items = computed(() => list.data.value?.items ?? []);

const pattern = ref('');
const port = ref('');
const error = ref('');
const busy = ref(false);
const removing = ref<string | null>(null);

async function add() {
  error.value = '';
  const p = port.value.trim();
  if (p && !(/^\d+$/.test(p) && Number(p) >= 1 && Number(p) <= 65535)) {
    error.value = t('egress.expectations.badPort');
    return;
  }
  busy.value = true;
  try {
    await api('/egress/expected', {
      method: 'POST',
      body: { cluster: props.clusterId, pattern: pattern.value, ...(p ? { port: Number(p) } : {}) },
    });
    pattern.value = '';
    port.value = '';
    toast.show(t('egress.expected.marked'));
    await list.load();
    emit('changed');
  } catch (err) {
    error.value =
      err instanceof ApiError && (err.status === 400 || err.status === 409)
        ? t('egress.expected.refused', { reason: err.message })
        : t('egress.expected.failed');
  } finally {
    busy.value = false;
  }
}

async function remove(e: EgressExpectation) {
  removing.value = e.id;
  try {
    await api(`/egress/expected/${e.id}`, { method: 'DELETE' });
    toast.show(t('egress.expected.undone'));
    await list.load();
    emit('changed');
  } catch {
    toast.show(t('egress.expected.failed'), 'warning');
  } finally {
    removing.value = null;
  }
}

const forText = (e: EgressExpectation) =>
  e.source
    ? sourceName({ ...e.source, firstSeen: '', lastSeen: '', new: false })
    : t('egress.expected.every', { units: t(`egress.unit.${props.kind}`, 1) });
</script>

<template>
  <section
    aria-labelledby="expectations-title"
    class="overflow-hidden rounded-card border border-border bg-surface-1"
    data-testid="expectations"
  >
    <header
      class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border px-4 py-3"
    >
      <BadgeCheck class="size-4.5 shrink-0 text-primary" aria-hidden="true" />
      <h2 id="expectations-title" class="text-14 font-semibold text-text">
        {{ $t('egress.expectations.title') }}
      </h2>
      <span v-if="list.data.value" class="text-12 text-text-muted" data-testid="expectations-count">
        {{ items.length }}
      </span>
      <span class="w-full text-12 text-text-muted sm:ml-auto sm:w-auto">{{
        $t('egress.expectations.intro')
      }}</span>
    </header>

    <div
      v-if="list.error.value && !list.data.value"
      class="flex flex-wrap items-center gap-3 px-4 py-3 text-13 text-text-muted"
      role="status"
    >
      <CircleAlert class="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
      <span class="min-w-0 flex-1">{{ $t('egress.expectations.error') }}</span>
      <button type="button" class="text-primary hover:underline max-lg:min-h-11" @click="list.load">
        {{ $t('common.retry') }}
      </button>
    </div>
    <template v-else-if="list.data.value">
      <ul v-if="items.length" class="flex flex-col px-4" data-testid="expectations-rows">
        <li
          v-for="e in items"
          :key="e.id"
          class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border py-2.5 last:border-b-0"
          data-testid="expectation"
        >
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="font-mono text-13 break-all text-text"
              >{{ e.pattern
              }}<span class="text-text-muted">{{
                e.port ? `:${e.port}` : ` · ${$t('egress.expectations.anyPort')}`
              }}</span></span
            >
            <span class="text-12 text-text-muted">
              {{ forText(e) }} ·
              {{ $t('egress.expectations.covers', { n: e.matches }, e.matches) }} ·
              {{
                e.createdBy
                  ? $t('egress.expectations.by', {
                      by: e.createdBy,
                      when: ago(e.createdAt, t, now),
                    })
                  : ago(e.createdAt, t, now)
              }}
            </span>
          </div>
          <BaseButton
            v-if="auth.canManage"
            variant="ghost"
            :loading="removing === e.id"
            :aria-label="$t('egress.expectations.removeOne', { pattern: e.pattern })"
            data-testid="expectation-remove"
            @click="remove(e)"
            >{{ $t('egress.expectations.remove') }}</BaseButton
          >
        </li>
      </ul>
      <p v-else class="px-4 py-3 text-13 text-text-muted" data-testid="expectations-empty">
        {{ $t('egress.expectations.empty') }}
      </p>
      <form
        v-if="auth.canManage"
        class="flex flex-wrap items-end gap-2 border-t border-border px-4 py-3"
        data-testid="expectations-add"
        @submit.prevent="add"
      >
        <TextField
          v-model="pattern"
          class="min-w-48 flex-1"
          mono
          required
          :maxlength="253"
          :label="$t('egress.expectations.addLabel', { units: $t(`egress.unit.${kind}`, 2) })"
          :placeholder="$t('egress.expectations.placeholder')"
          data-testid="expectations-pattern"
        />
        <TextField
          v-model="port"
          class="w-28"
          inputmode="numeric"
          :maxlength="5"
          :label="$t('egress.expectations.port')"
          :placeholder="$t('egress.expectations.anyPort')"
          data-testid="expectations-port"
        />
        <BaseButton type="submit" :loading="busy" data-testid="expectations-submit">{{
          $t('egress.expectations.add')
        }}</BaseButton>
        <p
          v-if="error"
          class="w-full text-13 text-critical"
          role="alert"
          data-testid="expectations-error"
        >
          {{ error }}
        </p>
      </form>
    </template>
  </section>
</template>
