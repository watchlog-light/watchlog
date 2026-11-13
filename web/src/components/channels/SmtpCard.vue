<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Mail } from '@lucide/vue';
import type {
  AlertChannel,
  SmtpSettings,
  SmtpSettingsRequest,
  SmtpSettingsResponse,
  SmtpTestResult,
} from '@watchlog/api-types';
import { computed, onMounted, reactive, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import TonePill from '@/components/kube/TonePill.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import TextField from '@/components/ui/TextField.vue';
import { useLoader } from '@/composables/useLoader';
import { useAuthStore } from '@/stores/auth';
import AddChannelForm from './AddChannelForm.vue';
import ChannelRow from './ChannelRow.vue';

// Email (ADR-093): the email server is set here, once for the installation; email
// channels then only need recipients. The password is write-only. When the server's
// environment sets the email server, the fields are read-only. In Cloud the email server
// is the operator's (env only; Settings' SMTP routes answer 404 there): the card asks
// nothing, shows email as ready and only lists the recipients.
const props = defineProps<{
  channels: AlertChannel[];
  canManage: boolean;
  firstChannel: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const id = useId();

const SECURITY = ['starttls', 'tls', 'none'] as const;
const form = reactive({
  host: '',
  port: 587,
  security: 'starttls' as SmtpSettings['security'],
  username: '',
  password: '',
  from: '',
});
const page = useLoader(async () => {
  const { smtp } = await api<SmtpSettingsResponse>('/settings/smtp');
  if (smtp) {
    Object.assign(form, {
      host: smtp.host,
      port: smtp.port,
      security: smtp.security,
      username: smtp.username,
      from: smtp.from,
      password: '',
    });
  }
  return smtp;
});
const smtp = computed(() => page.data.value ?? null);
const cloud = computed(() => useAuthStore().isCloud);
/** Email channels can be added: Cloud's server, or one set here or by the environment. */
const ready = computed(() => cloud.value || !!smtp.value);
const readonly = computed(() => smtp.value?.source === 'env' || !props.canManage);
const portText = computed({
  get: () => String(form.port),
  set: (v: string) => (form.port = Number(v) || 0),
});

const testing = ref(false);
const saving = ref(false);
const result = ref<SmtpTestResult | null>(null);
const error = ref<string>();
const saved = ref(false);

function body(): SmtpSettingsRequest {
  return {
    host: form.host.trim(),
    port: form.port,
    security: form.security,
    username: form.username.trim(),
    from: form.from.trim(),
    ...(form.password ? { password: form.password } : {}),
  };
}
function problem(err: unknown) {
  return err instanceof ApiError && err.problem?.detail
    ? err.problem.detail
    : t('channels.smtp.failed');
}

async function test() {
  testing.value = true;
  error.value = undefined;
  result.value = null;
  try {
    result.value = await api<SmtpTestResult>('/settings/smtp/test', {
      method: 'POST',
      body: smtp.value?.source === 'env' ? undefined : body(),
    });
  } catch (err) {
    error.value = problem(err);
  } finally {
    testing.value = false;
  }
}
async function save() {
  saving.value = true;
  error.value = undefined;
  saved.value = false;
  try {
    const res = await api<SmtpSettingsResponse>('/settings/smtp', { method: 'PUT', body: body() });
    page.data.value = res.smtp;
    form.password = '';
    saved.value = true;
    emit('changed');
  } catch (err) {
    error.value = problem(err);
  } finally {
    saving.value = false;
  }
}

const pill = computed(() =>
  cloud.value
    ? { tone: 'ok' as const, label: t('channels.smtp.cloudReady') }
    : !smtp.value
      ? { tone: 'neutral' as const, label: t('channels.smtp.notSet') }
      : smtp.value.source === 'env'
        ? { tone: 'ok' as const, label: t('channels.smtp.fromEnv') }
        : { tone: 'ok' as const, label: t('channels.smtp.set') },
);
const adding = ref(false);

onMounted(() => {
  if (!cloud.value) void page.load();
});
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
    data-testid="smtp-card"
  >
    <header class="flex flex-wrap items-center gap-2.5">
      <span
        class="flex size-8 items-center justify-center rounded-control bg-surface-3 text-text-muted"
      >
        <Mail class="size-4" aria-hidden="true" />
      </span>
      <h2 class="text-14 font-semibold text-text">{{ $t('channels.smtp.title') }}</h2>
      <span class="flex-1" />
      <TonePill v-if="cloud || page.loaded.value" v-bind="pill" />
    </header>

    <p v-if="cloud" class="text-13 text-text-muted" data-testid="smtp-cloud">
      {{ $t('channels.smtp.cloud') }}
    </p>
    <ErrorState
      v-else-if="page.error.value"
      inline
      :message="$t('channels.smtp.loadFailed')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <div v-if="!cloud && page.skeleton.value" class="flex flex-col gap-2">
      <Skeleton shape="rect" class="h-9 w-full" />
      <Skeleton shape="rect" class="h-9 w-full" />
    </div>
    <form
      v-else-if="!cloud && page.loaded.value"
      class="flex flex-col gap-3"
      novalidate
      @submit.prevent="save"
    >
      <p v-if="smtp?.source === 'env'" class="text-12 text-text-muted" data-testid="smtp-from-env">
        {{ $t('settings.fromEnvironment') }}
      </p>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
        <TextField
          v-model="form.host"
          :label="$t('channels.smtp.host')"
          :readonly="readonly"
          placeholder="smtp.example.com"
        />
        <TextField v-model="portText" :label="$t('channels.smtp.port')" :readonly="readonly" />
      </div>
      <fieldset class="flex flex-col gap-1.5">
        <legend class="mb-1.5 text-13 font-medium text-text">
          {{ $t('channels.smtp.security') }}
        </legend>
        <div
          class="inline-flex w-fit overflow-hidden rounded-control border border-border"
          role="radiogroup"
        >
          <label
            v-for="s in SECURITY"
            :key="s"
            :class="[
              'cursor-pointer border-r border-border px-3 py-1.5 text-12 last:border-r-0 max-lg:flex max-lg:min-h-11 max-lg:items-center max-lg:px-3.5 max-lg:text-13',
              form.security === s ? 'bg-surface-3 text-text' : 'text-text-muted hover:bg-surface-2',
              readonly ? 'cursor-default' : '',
            ]"
          >
            <input
              v-model="form.security"
              type="radio"
              :name="`${id}-security`"
              :value="s"
              class="sr-only"
              :disabled="readonly"
            />
            {{ $t(`channels.smtp.securityOptions.${s}`) }}
          </label>
        </div>
      </fieldset>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          v-model="form.username"
          :label="$t('channels.smtp.username')"
          :readonly="readonly"
          autocomplete="off"
        />
        <TextField
          v-model="form.password"
          type="password"
          autocomplete="new-password"
          :label="$t('channels.smtp.password')"
          :readonly="readonly"
          :placeholder="smtp?.passwordSet ? '••••••••' : ''"
          :hint="
            smtp?.passwordEnds
              ? $t('channels.smtp.passwordEnds', { end: smtp.passwordEnds })
              : smtp?.passwordSet
                ? $t('channels.smtp.passwordSet')
                : undefined
          "
        />
      </div>
      <TextField
        v-model="form.from"
        :label="$t('channels.smtp.from')"
        :readonly="readonly"
        placeholder="WatchLog <alerts@example.com>"
      />
      <p
        v-if="result"
        :class="[
          'rounded-control px-2.5 py-2 text-12',
          result.ok ? 'bg-surface-2 text-text' : 'bg-surface-2 text-critical',
        ]"
        role="status"
        data-testid="smtp-result"
      >
        {{
          result.ok
            ? $t('channels.smtp.testOk', { to: result.to, s: (result.ms / 1000).toFixed(1) })
            : $t('channels.smtp.testFailed', { error: result.error })
        }}
      </p>
      <p v-if="error" class="text-13 text-critical" role="alert">{{ error }}</p>
      <div v-if="canManage" class="flex flex-wrap items-center gap-2">
        <BaseButton variant="secondary" :loading="testing" data-testid="smtp-test" @click="test">
          {{ $t('channels.smtp.test') }}
        </BaseButton>
        <span v-if="saved" class="text-13 text-text-muted" role="status">{{
          $t('settings.saved')
        }}</span>
        <span class="flex-1" />
        <BaseButton
          v-if="smtp?.source !== 'env'"
          type="submit"
          :loading="saving"
          data-testid="smtp-save"
        >
          {{ $t('common.save') }}
        </BaseButton>
      </div>
    </form>

    <div class="border-t border-dashed border-border pt-3">
      <div class="flex items-center gap-2">
        <h3 class="flex-1 text-13 font-medium text-text">{{ $t('channels.smtp.recipients') }}</h3>
        <BaseButton
          v-if="canManage && !adding"
          variant="ghost"
          :disabled="!ready"
          data-testid="add-email"
          @click="adding = true"
        >
          {{ $t('channels.add') }}
        </BaseButton>
      </div>
      <p v-if="!ready" class="text-12 text-text-muted">{{ $t('channels.smtp.needServer') }}</p>
      <ul v-if="channels.length" class="flex flex-col">
        <ChannelRow
          v-for="c in channels"
          :key="c.id"
          :channel="c"
          :detail="(c.config.recipients ?? []).join(', ')"
          :can-manage="canManage"
          @changed="emit('changed')"
        />
      </ul>
      <AddChannelForm
        v-if="adding"
        type="email"
        :first-channel="firstChannel"
        @created="
          adding = false;
          emit('changed');
        "
        @cancel="adding = false"
      />
    </div>
  </section>
</template>
