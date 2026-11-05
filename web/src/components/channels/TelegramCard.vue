<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronRight, Send, TriangleAlert } from '@lucide/vue';
import type {
  AlertChannel,
  CreatedAlertChannel,
  TelegramConnect,
  TelegramReachability,
  TelegramSettings,
} from '@watchlog/api-types';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError, hasProblemType, ProblemType } from '@/api/client';
import TonePill from '@/components/kube/TonePill.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import ChannelRow from './ChannelRow.vue';

// Telegram (ADR-080, ADR-093): a guided setup — paste the token from @BotFather, start
// the bot or add it to a group, and the chat connects by itself (the link works for
// 10 minutes). When this server cannot reach Telegram, step 1 says so and offers the
// HTTPS proxy setting.
const props = defineProps<{
  channels: AlertChannel[];
  canManage: boolean;
  firstChannel: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const POLL_MS = 3000;

const setup = ref(false);
const token = ref('');
const error = ref<string>();
const unreachable = ref<string | null>(null);
const saving = ref(false);
/** The channel being connected and its deep link. */
const pending = ref<{ id: string; link: string; expiresAt: number; bot: string } | null>(null);
const now = ref(Date.now());
let poll: ReturnType<typeof setInterval> | undefined;
let tick: ReturnType<typeof setInterval> | undefined;

const connected = computed(() => props.channels.filter((c) => c.config.connected));
const waitingChannel = computed(() =>
  pending.value ? props.channels.find((c) => c.id === pending.value!.id) : undefined,
);
const step = computed(() => (!pending.value ? 1 : waitingChannel.value?.config.connected ? 4 : 3));
const left = computed(() => Math.max(0, (pending.value?.expiresAt ?? 0) - now.value));
const countdown = computed(() => {
  const s = Math.ceil(left.value / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});

async function checkReach() {
  try {
    const r = await api<TelegramReachability>('/settings/telegram/reachability');
    unreachable.value = r.reachable ? null : r.error;
    if (!r.reachable) proxyOpen.value = true;
  } catch {
    unreachable.value = null;
  }
}

function startWaiting(id: string, link: string, expiresAt: string) {
  setup.value = true;
  const bot = /t\.me\/([^?]+)/.exec(link)?.[1] ?? '';
  pending.value = { id, link, expiresAt: Date.parse(expiresAt), bot };
  clearInterval(poll);
  clearInterval(tick);
  poll = setInterval(() => emit('changed'), POLL_MS);
  tick = setInterval(() => {
    now.value = Date.now();
    if (left.value === 0) clearInterval(poll);
  }, 1000);
}

async function createBot() {
  setup.value = true;
  error.value = undefined;
  saving.value = true;
  try {
    const res = await api<CreatedAlertChannel>('/alert-channels', {
      method: 'POST',
      body: {
        type: 'telegram',
        name: t('channels.types.telegram'),
        settings: { botToken: token.value.trim() },
        useForAllRules: props.firstChannel,
      },
    });
    token.value = '';
    emit('changed');
    if (res.connect) startWaiting(res.channel.id, res.connect.link, res.connect.expiresAt);
  } catch (err) {
    if (hasProblemType(err, ProblemType.telegramUnreachable)) {
      unreachable.value = (err as ApiError).problem!.detail ?? '';
      proxyOpen.value = true;
    } else {
      error.value =
        err instanceof ApiError && err.problem?.detail
          ? err.problem.detail
          : t('channels.errors.create');
    }
  } finally {
    saving.value = false;
  }
}

async function newLink(ch: AlertChannel) {
  setup.value = true;
  const res = await api<TelegramConnect>(`/alert-channels/${ch.id}/telegram/connect`, {
    method: 'POST',
  });
  startWaiting(ch.id, res.link, res.expiresAt);
}

watch(step, (s) => {
  if (s === 4) {
    clearInterval(poll);
    clearInterval(tick);
  }
});

function finish() {
  pending.value = null;
  setup.value = false;
}

// Proxy ("Can't reach Telegram from this server?")
const proxyOpen = ref(false);
const proxy = ref<TelegramSettings | null>(null);
const proxyUrl = ref('');
const proxySaving = ref(false);
const proxyError = ref<string>();
const proxySource = computed(() => proxy.value?.source ?? 'none');
async function loadProxy() {
  try {
    proxy.value = await api<TelegramSettings>('/settings/telegram');
    proxyUrl.value = proxy.value.proxyUrl ?? '';
  } catch {
    proxy.value = null;
  }
}
async function saveProxy() {
  proxySaving.value = true;
  proxyError.value = undefined;
  try {
    proxy.value = await api<TelegramSettings>('/settings/telegram', {
      method: 'PUT',
      body: { proxyUrl: proxyUrl.value.trim() || null },
    });
    await checkReach();
  } catch (err) {
    proxyError.value =
      err instanceof ApiError && err.problem?.detail
        ? err.problem.detail
        : t('channels.errors.create');
  } finally {
    proxySaving.value = false;
  }
}

function openSetup() {
  setup.value = true;
  void checkReach();
}

onMounted(() => {
  void loadProxy();
  if (props.channels.length === 0) void checkReach();
});
onBeforeUnmount(() => {
  clearInterval(poll);
  clearInterval(tick);
});

const pill = computed(() =>
  connected.value.length
    ? {
        tone: 'ok' as const,
        label: t('channels.telegram.connectedCount', { n: connected.value.length }),
      }
    : pending.value || setup.value
      ? { tone: 'neutral' as const, label: t('channels.telegram.settingUp') }
      : { tone: 'neutral' as const, label: t('channels.telegram.notSet') },
);
const showSteps = computed(() => setup.value || (props.channels.length === 0 && props.canManage));
const stepClass = (n: number) => [
  'flex size-5.5 shrink-0 items-center justify-center rounded-full font-mono text-12',
  step.value > n ? 'bg-surface-3 text-ok' : 'bg-surface-3 text-text-muted',
];
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
    data-testid="telegram-card"
  >
    <header class="flex flex-wrap items-center gap-2.5">
      <span
        class="flex size-8 items-center justify-center rounded-control bg-surface-3 text-text-muted"
      >
        <Send class="size-4" aria-hidden="true" />
      </span>
      <h2 class="text-14 font-semibold text-text">{{ $t('channels.types.telegram') }}</h2>
      <span class="flex-1" />
      <TonePill v-bind="pill" />
    </header>

    <ul v-if="channels.length" class="flex flex-col">
      <ChannelRow
        v-for="c in channels"
        :key="c.id"
        :channel="c"
        :detail="
          c.config.connected
            ? `@${c.config.botName} → ${c.config.chatName ?? ''}`
            : `@${c.config.botName ?? ''}`
        "
        :can-manage="canManage"
        @changed="emit('changed')"
      />
    </ul>
    <div v-if="canManage && !showSteps" class="flex flex-wrap gap-2">
      <BaseButton
        v-for="c in channels.filter((x) => !x.config.connected)"
        :key="c.id"
        variant="secondary"
        data-testid="connect-telegram"
        @click="newLink(c)"
      >
        {{ $t('channels.telegram.connectAction') }}
      </BaseButton>
      <BaseButton variant="ghost" data-testid="add-telegram" @click="openSetup">
        {{ $t('channels.telegram.addAnother') }}
      </BaseButton>
    </div>

    <ol v-if="showSteps" class="flex flex-col gap-3" data-testid="telegram-steps">
      <li class="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5">
        <span :class="stepClass(1)" aria-hidden="true">{{ step > 1 ? '✓' : '1' }}</span>
        <div class="flex min-w-0 flex-col gap-2">
          <p class="text-14 font-medium text-text">{{ $t('channels.telegram.step1') }}</p>
          <p class="text-13 text-text-muted">{{ $t('channels.telegram.step1Hint') }}</p>
          <div
            v-if="unreachable !== null && step === 1"
            class="flex items-start gap-2 rounded-control border border-border bg-surface-2 px-3 py-2 text-13 text-text-muted"
            role="alert"
            data-testid="telegram-unreachable"
          >
            <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <span>{{ $t('channels.telegram.unreachable', { error: unreachable }) }}</span>
          </div>
          <form
            v-if="step === 1"
            class="flex flex-wrap items-end gap-2"
            novalidate
            @submit.prevent="createBot"
          >
            <TextField
              v-model="token"
              type="password"
              autocomplete="off"
              :label="$t('channels.form.botToken')"
              :error="error"
              class="min-w-64 flex-1"
            />
            <BaseButton
              type="submit"
              :loading="saving"
              :disabled="!token.trim()"
              data-testid="telegram-continue"
            >
              {{ $t('channels.telegram.continue') }}
            </BaseButton>
          </form>
        </div>
      </li>
      <li class="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5">
        <span :class="stepClass(2)" aria-hidden="true">{{ step > 2 ? '✓' : '2' }}</span>
        <div class="flex min-w-0 flex-col gap-1.5">
          <p :class="['text-14 font-medium', step >= 2 ? 'text-text' : 'text-text-subtle']">
            {{ $t('channels.telegram.step2') }}
          </p>
          <p v-if="pending" class="text-13 text-text-muted">
            {{ $t('channels.telegram.step2Hint', { bot: pending.bot }) }}
          </p>
          <a
            v-if="pending && step === 3"
            :href="pending.link"
            target="_blank"
            rel="noopener"
            class="inline-flex h-9 w-fit items-center rounded-control border border-border-strong px-4 text-14 font-semibold text-text hover:bg-surface-2"
            data-testid="telegram-link"
          >
            {{ $t('channels.telegram.open') }}
          </a>
        </div>
      </li>
      <li class="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5">
        <span :class="stepClass(3)" aria-hidden="true">{{ step > 3 ? '✓' : '3' }}</span>
        <div class="flex min-w-0 flex-col gap-1.5">
          <template v-if="step === 4">
            <p class="text-14 font-medium text-text" role="status" data-testid="telegram-connected">
              {{
                $t('channels.telegram.connected', { chat: waitingChannel?.config.chatName ?? '' })
              }}
            </p>
            <BaseButton class="self-start" variant="secondary" @click="finish">{{
              $t('channels.done')
            }}</BaseButton>
          </template>
          <template v-else-if="pending && left > 0">
            <p class="text-14 font-medium text-text">{{ $t('channels.telegram.waiting') }}</p>
            <p class="text-13 text-text-muted" data-testid="telegram-countdown">
              {{ $t('channels.telegram.expires', { time: countdown }) }}
            </p>
          </template>
          <template v-else-if="pending">
            <p class="text-14 font-medium text-text">{{ $t('channels.telegram.expired') }}</p>
            <BaseButton class="self-start" variant="secondary" @click="newLink(waitingChannel!)">
              {{ $t('channels.telegram.newLink') }}
            </BaseButton>
          </template>
          <p v-else class="text-14 font-medium text-text-subtle">
            {{ $t('channels.telegram.step3') }}
          </p>
        </div>
      </li>
    </ol>

    <div class="border-t border-dashed border-border pt-3">
      <button
        type="button"
        class="flex items-center gap-1.5 text-13 text-text-muted hover:text-text"
        :aria-expanded="proxyOpen"
        data-testid="telegram-proxy-toggle"
        @click="proxyOpen = !proxyOpen"
      >
        <ChevronRight
          :class="['size-4 transition-transform', proxyOpen ? 'rotate-90' : '']"
          aria-hidden="true"
        />
        {{ $t('channels.telegram.proxyQuestion') }}
      </button>
      <form
        v-if="proxyOpen && proxy"
        class="mt-2 flex flex-wrap items-end gap-2"
        novalidate
        @submit.prevent="saveProxy"
      >
        <TextField
          v-model="proxyUrl"
          :label="$t('channels.telegram.proxy')"
          :hint="
            proxySource === 'env'
              ? $t('settings.fromEnvironment')
              : $t('channels.telegram.proxyHint')
          "
          :readonly="proxySource === 'env' || !canManage"
          :error="proxyError"
          placeholder="http://proxy.example.com:3128"
          class="min-w-64 flex-1"
        />
        <BaseButton
          v-if="proxySource !== 'env' && canManage"
          type="submit"
          variant="secondary"
          :loading="proxySaving"
          data-testid="telegram-proxy-save"
        >
          {{ $t('common.save') }}
        </BaseButton>
      </form>
    </div>
  </section>
</template>
