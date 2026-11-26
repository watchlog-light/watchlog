<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Push a value, complete on one screen (1.0.3): a token made right here, the number (what it
// belongs to, its name and value, and what its name makes it), the command filled in with
// this installation's address in six languages, a test value the page sends itself, and the
// moment the first value arrives.
import type { OwnMetricsSummary } from '@watchlog/api-types';
import {
  PUSH_EXAMPLE,
  PUSH_LANG_NAMES,
  PUSH_LANGS,
  pushSnippet,
  type PushLang,
} from '@watchlog/snippets';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '@/api/client';
import { ownMetricsApi } from '@/api/own-metrics';
import BaseButton from '@/components/ui/BaseButton.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import TextField from '@/components/ui/TextField.vue';
import { kindOfName, nameOk, ownerOptions, pushOwner, valueOk } from '@/lib/own-add';
import { useAuthStore } from '@/stores/auth';
import FirstValue from './FirstValue.vue';
import StepRow from './StepRow.vue';
import TokenStep, { type MadeToken } from './TokenStep.vue';

const props = defineProps<{
  cluster: string;
  summary: OwnMetricsSummary;
  made: MadeToken | null;
  watching: string | null;
}>();
const emit = defineEmits<{ made: [token: MadeToken]; watch: [id: string | null]; changed: [] }>();
const { t } = useI18n();
const auth = useAuthStore();

const kube = computed(() => props.summary.kind === 'kubernetes');
const owners = computed(() => ownerOptions(props.summary));
const owner = ref<string | null>(null);
// One server or one workload: it is the one.
watch(
  owners,
  (list) => {
    if (owner.value && !list.some((o) => o.value === owner.value)) owner.value = null;
    if (!owner.value && list.length === 1) owner.value = list[0]!.value;
  },
  { immediate: true },
);

const name = ref(PUSH_EXAMPLE.name);
const value = ref(PUSH_EXAMPLE.value);
const kind = computed(() => kindOfName(name.value.trim()));
const lang = ref<PushLang>('curl');
const code = computed(() =>
  pushSnippet(lang.value, {
    endpoint: props.summary.endpoint,
    token: props.made?.value ?? '',
    name: nameOk(name.value.trim()) ? name.value.trim() : PUSH_EXAMPLE.name,
    value: value.value,
    owner: pushOwner(props.summary.kind, owner.value),
  }),
);
function useTimestamp() {
  name.value = 'backup_last_success_timestamp_seconds';
  value.value = String(Math.floor(Date.now() / 1000));
  lang.value = 'cron';
}

// "Send a test value for me": the token is made first when there is none yet.
const tokenStep = ref<InstanceType<typeof TokenStep> | null>(null);
const first = ref<InstanceType<typeof FirstValue> | null>(null);
const sending = ref(false);
const error = ref('');
const refused = ref<'sources' | 'series' | null>(null);
async function sendTest() {
  error.value = '';
  refused.value = null;
  sending.value = true;
  try {
    const token = props.made ?? (await tokenStep.value?.create()) ?? null;
    if (!token) return;
    const o = pushOwner(props.summary.kind, owner.value);
    const r = await ownMetricsApi.sendTestValue(props.cluster, { tokenId: token.id, ...(o ?? {}) });
    if (!r.stored) refused.value = r.refused ?? 'series';
    emit('changed');
    await first.value?.look();
  } catch (err) {
    error.value =
      (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.add.push.testFailed');
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col" data-testid="own-push">
    <StepRow :n="1" :title="$t('ownMetrics.add.token.h')">
      <TokenStep
        ref="tokenStep"
        :cluster="cluster"
        :summary="summary"
        :made="made"
        :watching="props.watching"
        @made="emit('made', $event)"
        @watch="emit('watch', $event)"
        @changed="emit('changed')"
      />
    </StepRow>

    <StepRow :n="2" :title="$t('ownMetrics.add.push.number')">
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="flex min-w-0 flex-col gap-1.5 text-13 font-medium text-text">
          {{
            $t(kube ? 'ownMetrics.add.push.belongsWorkload' : 'ownMetrics.add.push.belongsServer')
          }}
          <ComboBox
            v-model="owner"
            :options="owners"
            :label="
              $t(kube ? 'ownMetrics.add.push.belongsWorkload' : 'ownMetrics.add.push.belongsServer')
            "
            :placeholder="
              $t(kube ? 'ownMetrics.add.push.pickWorkload' : 'ownMetrics.add.push.pickServer')
            "
            clearable
            testid="own-push-owner"
          />
        </label>
        <TextField
          v-model="name"
          technical
          :label="$t('ownMetrics.add.push.name')"
          :maxlength="200"
          :error="nameOk(name.trim()) ? undefined : $t('ownMetrics.add.push.badName')"
          data-testid="own-push-name"
        />
        <TextField
          v-model="value"
          technical
          inputmode="numeric"
          :label="$t('ownMetrics.add.push.value')"
          :maxlength="40"
          :error="valueOk(value) ? undefined : $t('ownMetrics.add.push.badValue')"
          data-testid="own-push-value"
        />
      </div>
      <p v-if="!owner" class="mt-2 text-12 text-text-muted">
        {{ $t('ownMetrics.add.push.noOwner') }}
      </p>
      <ul
        class="mt-3 grid gap-2 text-13 leading-relaxed sm:grid-cols-3"
        data-testid="own-push-kinds"
      >
        <li
          v-for="k in ['counter', 'gauge', 'timestamp'] as const"
          :key="k"
          :class="[
            'rounded-control border px-3 py-2.5',
            kind === k ? 'border-ok/50 bg-ok/10 text-text' : 'border-border text-text-muted',
          ]"
          :data-testid="`own-push-kind-${k}`"
          :aria-current="kind === k ? 'true' : undefined"
        >
          <b class="font-semibold text-text">{{ $t(`ownMetrics.add.push.${k}.b`) }}</b>
          {{ $t(`ownMetrics.add.push.${k}.t`) }}
          <button
            v-if="k === 'timestamp' && kind !== 'timestamp'"
            type="button"
            class="text-link hover:underline max-lg:block max-lg:min-h-11"
            data-testid="own-push-timestamp"
            @click="useTimestamp"
          >
            {{ $t('ownMetrics.add.push.timestamp.use') }}
          </button>
        </li>
      </ul>
    </StepRow>

    <StepRow :n="3" :title="$t('ownMetrics.add.push.run')">
      <div
        role="tablist"
        class="flex flex-wrap gap-1.5"
        :aria-label="$t('ownMetrics.add.push.lang')"
      >
        <button
          v-for="l in PUSH_LANGS"
          :key="l"
          type="button"
          role="tab"
          :aria-selected="lang === l"
          :class="[
            'min-h-8 rounded-full border px-3 text-13 max-lg:min-h-11',
            lang === l
              ? 'border-border-strong bg-surface-3 font-semibold text-text'
              : 'border-border text-text-muted hover:text-text',
          ]"
          :data-testid="`own-push-lang-${l}`"
          @click="lang = l"
        >
          {{ PUSH_LANG_NAMES[l] }}
        </button>
      </div>
      <div class="mt-2.5 min-w-0" data-testid="own-push-code">
        <CodeBlock :code="code" :label="PUSH_LANG_NAMES[lang]" />
      </div>
      <p v-if="!made" class="mt-2 text-13 text-text-muted" data-testid="own-token-hint">
        {{ $t('ownMetrics.add.token.fill') }}
      </p>
      <div v-if="auth.canManage" class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span class="text-13 text-text-muted">{{ $t('ownMetrics.add.push.orTest') }}</span>
        <BaseButton
          variant="secondary"
          :loading="sending"
          data-testid="own-push-test"
          @click="sendTest"
        >
          {{ $t('ownMetrics.add.push.test') }}
        </BaseButton>
      </div>
      <p
        v-if="error"
        class="mt-2 text-13 text-critical-text"
        role="alert"
        data-testid="own-push-error"
      >
        {{ error }}
      </p>
      <p class="mt-3 text-12 leading-relaxed text-text-subtle">
        {{ $t('ownMetrics.add.push.more') }}
      </p>
    </StepRow>

    <FirstValue
      ref="first"
      class="mt-1"
      :cluster="cluster"
      :summary="summary"
      :token-id="made?.id ?? props.watching"
      :fresh="!!made"
      way="push"
      :refused="refused"
      @changed="emit('changed')"
    />
  </div>
</template>
