<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { EgressExpectationCreated, EgressRow, EgressSource } from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import TextField from '@/components/ui/TextField.vue';
import { useNarrow } from '@/composables/useNarrow';
import { sourceInput, sourceName, suggestPattern } from '@/lib/egress';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';

// "Mark expected" and "Undo" on a destination (ADR-186): for one source or every workload /
// container, this destination or a pattern (`*.amazonaws.com`, a CIDR for raw networks), this
// port or any. Only Owners and Admins see them; the server refuses anyone else too. "Undo"
// removes the expectations that cover the row (a pattern goes for every row it covers).
const props = defineProps<{
  row: EgressRow;
  clusterId: string;
  kind: 'kubernetes' | 'docker';
  /** On a source's page: only that source is offered, besides every source. */
  source?: EgressSource;
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();
const narrow = useNarrow();

const open = ref(false);
const busy = ref(false);
const error = ref('');
const sources = computed(() => (props.source ? [props.source] : props.row.sources));
/** 'all', or the index of one of `sources`. */
const scope = ref<string>('0');
const what = ref<'exact' | 'pattern'>('exact');
const pattern = ref('');
const anyPort = ref(false);

const shown = computed(() => auth.canManage && props.row.class !== 'internet');
const expected = computed(() => !!props.row.expected?.ids.length);
const unit = computed(() => t(`egress.unit.${props.kind}`, 1));

function start() {
  scope.value = sources.value.length === 1 ? '0' : 'all';
  const suggested = suggestPattern(props.row);
  what.value = 'exact';
  pattern.value = suggested;
  anyPort.value = false;
  error.value = '';
  open.value = true;
}
watch(what, (w) => {
  // A pattern usually covers any port; one destination, its own.
  anyPort.value = w === 'pattern';
});

async function save() {
  busy.value = true;
  error.value = '';
  const one = scope.value === 'all' ? null : sources.value[Number(scope.value)];
  try {
    await api<EgressExpectationCreated>('/egress/expected', {
      method: 'POST',
      body: {
        cluster: props.clusterId,
        pattern: what.value === 'exact' ? props.row.destination : pattern.value,
        ...(anyPort.value || !props.row.port ? {} : { port: props.row.port }),
        ...(one ? { source: sourceInput(one) } : {}),
      },
    });
    open.value = false;
    toast.show(t('egress.expected.marked'));
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

async function undo() {
  busy.value = true;
  try {
    for (const id of props.row.expected?.ids ?? []) {
      await api(`/egress/expected/${id}`, { method: 'DELETE' });
    }
    toast.show(t('egress.expected.undone'));
    emit('changed');
  } catch {
    toast.show(t('egress.expected.failed'), 'warning');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <template v-if="shown">
    <BaseButton
      v-if="expected"
      variant="ghost"
      :loading="busy"
      :title="
        row.expected!.pattern !== row.destination
          ? $t('egress.expected.undoPattern', { pattern: row.expected!.pattern })
          : undefined
      "
      data-testid="expected-undo"
      @click="undo"
      >{{ $t('egress.expected.undo') }}</BaseButton
    >
    <BaseButton v-else variant="secondary" data-testid="expected-mark" @click="start">{{
      $t('egress.expected.mark')
    }}</BaseButton>
    <ModalDialog
      v-model:open="open"
      :title="$t('egress.expected.title')"
      :description="$t('egress.expected.description')"
    >
      <form class="flex flex-col gap-4" data-testid="expected-form" @submit.prevent="save">
        <p class="font-mono text-13 break-all text-text">
          {{ row.destination }}<span v-if="row.port" class="text-text-muted">:{{ row.port }}</span>
        </p>
        <fieldset class="flex flex-col gap-2">
          <legend class="mb-1 text-13 font-medium text-text">
            {{ $t('egress.expected.for') }}
          </legend>
          <label
            v-for="(s, i) in sources"
            :key="sourceName(s)"
            class="flex min-h-9 items-center gap-2 text-14 text-text max-lg:min-h-11"
          >
            <input v-model="scope" type="radio" name="scope" :value="String(i)" />
            {{ $t('egress.expected.onlySource', { source: sourceName(s) }) }}
          </label>
          <label class="flex min-h-9 items-center gap-2 text-14 text-text max-lg:min-h-11">
            <input v-model="scope" type="radio" name="scope" value="all" data-testid="scope-all" />
            {{ $t('egress.expected.every', { units: unit }) }}
          </label>
        </fieldset>
        <fieldset class="flex flex-col gap-2">
          <legend class="mb-1 text-13 font-medium text-text">
            {{ $t('egress.expected.what') }}
          </legend>
          <label class="flex min-h-9 items-center gap-2 text-14 text-text max-lg:min-h-11">
            <input v-model="what" type="radio" name="what" value="exact" />
            {{ $t('egress.expected.exact') }}
          </label>
          <label class="flex min-h-9 items-center gap-2 text-14 text-text max-lg:min-h-11">
            <input
              v-model="what"
              type="radio"
              name="what"
              value="pattern"
              data-testid="what-pattern"
            />
            {{ $t('egress.expected.pattern') }}
          </label>
          <TextField
            v-if="what === 'pattern'"
            v-model="pattern"
            mono
            required
            :maxlength="253"
            :label="$t('egress.expected.patternLabel')"
            :hint="$t('egress.expected.patternHint')"
            data-testid="expected-pattern"
          />
        </fieldset>
        <label
          v-if="row.port"
          class="flex min-h-9 items-center gap-2 text-14 text-text max-lg:min-h-11"
        >
          <input v-model="anyPort" type="checkbox" data-testid="any-port" />
          {{ $t('egress.expected.anyPort', { port: row.port }) }}
        </label>
        <p class="text-12 text-text-subtle">{{ $t('egress.expected.stillAlerts') }}</p>
        <p v-if="error" class="text-13 text-critical" role="alert" data-testid="expected-error">
          {{ error }}
        </p>
        <div :class="narrow ? 'grid grid-cols-2 gap-2' : 'flex justify-end gap-2'">
          <BaseButton variant="secondary" @click="open = false">{{
            $t('common.cancel')
          }}</BaseButton>
          <BaseButton type="submit" :loading="busy" data-testid="expected-save">{{
            $t('egress.expected.save')
          }}</BaseButton>
        </div>
      </form>
    </ModalDialog>
  </template>
</template>
