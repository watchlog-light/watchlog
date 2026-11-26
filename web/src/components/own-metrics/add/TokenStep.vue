<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// The token step of Push and Send from Prometheus (1.0.3): a token is made right here and
// shown once, with Copy. Its value lives in this page only: it is never written to the
// address, to storage or to a log, and never read back from the server. A user who already
// has tokens is told so (an old one can't be shown again) and may say which one they will
// use, so the page can tell them when its value arrives.
import type { OwnMetricsSummary } from '@watchlog/api-types';
import { Check, Copy } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '@/api/client';
import { ownMetricsApi } from '@/api/own-metrics';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import TextField from '@/components/ui/TextField.vue';
import { useAuthStore } from '@/stores/auth';

export interface MadeToken {
  id: string;
  name: string;
  value: string;
}

const props = defineProps<{
  cluster: string;
  summary: OwnMetricsSummary;
  /** The token made in this page, if one was. */
  made: MadeToken | null;
  /** An older token the user says they will use. */
  watching: string | null;
}>();
const emit = defineEmits<{ made: [token: MadeToken]; watch: [id: string | null]; changed: [] }>();
const { t } = useI18n();
const auth = useAuthStore();

const tokens = computed(() => props.summary.tokens.filter((x) => x.id !== props.made?.id));
const name = ref(t('ownMetrics.add.token.defaultName'));
const error = ref('');
const making = ref(false);
const again = ref(false);

/** A name no token has yet: "my first metrics", then "my first metrics 2". */
function freeName(wanted: string): string {
  const taken = new Set(props.summary.tokens.map((x) => x.name));
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; i < 100; i++) if (!taken.has(`${wanted} ${i}`)) return `${wanted} ${i}`;
  return wanted;
}

async function create(): Promise<MadeToken | null> {
  error.value = '';
  const wanted = name.value.trim();
  if (!wanted) {
    error.value = t('ownMetrics.add.token.nameNeeded');
    return null;
  }
  making.value = true;
  try {
    // The default name may be taken by an earlier visit: the next free one is used.
    const isDefault = wanted === t('ownMetrics.add.token.defaultName');
    const res = await ownMetricsApi.createToken(
      props.cluster,
      isDefault ? freeName(wanted) : wanted,
    );
    const token = { id: res.id, name: res.name, value: res.value };
    again.value = false;
    emit('made', token);
    emit('changed');
    return token;
  } catch (err) {
    error.value = (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.tokens.failed');
    return null;
  } finally {
    making.value = false;
  }
}
defineExpose({ create });

const copied = ref<'idle' | 'copied' | 'failed'>('idle');
let timer: ReturnType<typeof setTimeout> | undefined;
async function copy() {
  try {
    await navigator.clipboard.writeText(props.made?.value ?? '');
    copied.value = 'copied';
  } catch {
    copied.value = 'failed';
  }
  clearTimeout(timer);
  timer = setTimeout(() => (copied.value = 'idle'), 2000);
}

const watchModel = computed<string | null>({
  get: () => props.watching,
  set: (v) => emit('watch', v),
});
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3" data-testid="own-token-step">
    <!-- The token made here: shown once. -->
    <div
      v-if="made && !again"
      class="flex flex-wrap items-center gap-x-3 gap-y-2"
      data-testid="own-token-made"
    >
      <code
        class="min-w-0 flex-1 basis-64 rounded-control border border-ok/50 bg-bg px-3 py-2 font-mono text-13 break-all text-text"
        data-testid="own-token-value"
        :aria-label="$t('ownMetrics.add.token.value')"
        >{{ made.value }}</code
      >
      <BaseButton variant="secondary" data-testid="own-token-copy" @click="copy">
        <component :is="copied === 'copied' ? Check : Copy" class="size-4" aria-hidden="true" />
        {{ copied === 'copied' ? $t('common.copied') : $t('common.copy') }}
      </BaseButton>
      <span class="basis-full text-12 text-warning-text">{{
        $t('ownMetrics.add.token.once')
      }}</span>
    </div>

    <template v-else-if="auth.canManage">
      <div v-if="tokens.length" class="flex flex-col gap-2" data-testid="own-token-have">
        <p class="text-13 leading-relaxed text-text-muted">
          {{
            $t(
              'ownMetrics.add.token.have',
              { n: tokens.length, names: tokens.map((x) => x.name).join(', ') },
              tokens.length,
            )
          }}
          {{ $t('ownMetrics.add.token.haveUse') }}
        </p>
        <label class="flex max-w-sm flex-col gap-1.5 text-13 text-text-muted">
          {{ $t('ownMetrics.add.token.watch') }}
          <ComboBox
            v-model="watchModel"
            :options="
              tokens.map((x) => ({ value: x.id, label: x.name, description: `${x.prefix}…` }))
            "
            :label="$t('ownMetrics.add.token.watch')"
            :placeholder="$t('ownMetrics.add.token.watchPick')"
            clearable
            testid="own-token-watch"
          />
        </label>
      </div>
      <form
        class="flex flex-wrap items-end gap-3"
        data-testid="own-token-inline"
        @submit.prevent="create"
      >
        <div class="min-w-0 flex-1 basis-56">
          <TextField v-model="name" :label="$t('ownMetrics.add.token.name')" :maxlength="64" />
        </div>
        <BaseButton
          type="submit"
          :variant="tokens.length ? 'secondary' : 'primary'"
          :loading="making"
          data-testid="own-token-make"
        >
          {{
            $t(
              tokens.length || made
                ? 'ownMetrics.add.token.another'
                : 'ownMetrics.add.token.create',
            )
          }}
        </BaseButton>
      </form>
    </template>

    <p v-else class="text-13 leading-relaxed text-text-muted" data-testid="own-token-locked">
      {{ $t(auth.demoMode ? 'ownMetrics.add.demo' : 'ownMetrics.add.token.locked') }}
    </p>
    <p v-if="error" class="text-13 text-critical-text" role="alert" data-testid="own-token-error">
      {{ error }}
    </p>
    <button
      v-if="made && !again && auth.canManage"
      type="button"
      class="self-start text-13 text-link hover:underline max-lg:min-h-11"
      data-testid="own-token-again"
      @click="again = true"
    >
      {{ $t('ownMetrics.add.token.another') }}
    </button>
  </div>
</template>
