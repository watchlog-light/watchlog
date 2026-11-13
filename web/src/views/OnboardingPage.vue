<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import logoUrl from '@watchlog/design-tokens/assets/logo.svg';
import { ArrowRight, Check, ExternalLink, Mail } from '@lucide/vue';
import type {
  AlertChannelList,
  CreateClusterResponse,
  IssueTokenResponse,
} from '@watchlog/api-types';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError, hasProblemType, ProblemType } from '@/api/client';
import { funnel, problemCode } from '@/api/cloud';
import AddChannelForm from '@/components/channels/AddChannelForm.vue';
import TelegramCard from '@/components/channels/TelegramCard.vue';
import TypeCard from '@/components/channels/TypeCard.vue';
import LiveChecklist from '@/components/onboarding/LiveChecklist.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import TextField from '@/components/ui/TextField.vue';
import { KIND_LOGO } from '@/components/ui/kindLogos';
import { useCopy } from '@/composables/useCopy';
import { useOnboardingStatus } from '@/composables/useOnboardingStatus';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';

// The Cloud wizard (ADR-176, SPEC §10.2; Choose.dc.html and Install.dc.html): Kubernetes
// or Docker and a name; then one command with the token in it, the live checklist ticking
// from the event stream, "Open dashboard" turning primary (and pulsing) with the first
// metrics, an optional alert channel, and troubleshooting after 2 minutes without an
// agent. The cluster's id is in the URL (?id=); the token is shown once, so a reload
// offers a new command instead.
type Kind = 'kubernetes' | 'docker';
type Method = 'helm' | 'kubectl' | 'dockerRun' | 'compose';
const TROUBLE_AFTER_MS = 2 * 60 * 1000;

const { t } = useI18n();
const auth = useAuthStore();
const clusters = useClustersStore();
const route = useRoute();
const router = useRouter();

const kind = ref<Kind>('kubernetes');
const slug = computed(() =>
  (auth.user?.org.slug ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40),
);
const suggested = (k: Kind) =>
  slug.value ? `${slug.value}-${k === 'docker' ? 'hosts' : 'prod'}` : 'my-cluster';
const name = ref(suggested('kubernetes'));
const nameEdited = ref(false);
watch(kind, (k) => {
  if (!nameEdited.value) name.value = suggested(k);
});
const createError = ref<string>();
const creating = ref(false);

/** The cluster being installed, and its one-time commands (lost on reload). */
const clusterId = computed(() => (typeof route.query.id === 'string' ? route.query.id : null));
const created = ref<{
  id: string;
  name: string;
  kind: Kind;
  install: CreateClusterResponse['install'];
} | null>(null);
const step = computed<'choose' | 'install'>(() => (clusterId.value ? 'install' : 'choose'));
const startedAt = ref(Date.now());

const known = computed(() => clusters.list.find((c) => c.id === clusterId.value) ?? null);
const current = computed(() =>
  created.value && created.value.id === clusterId.value
    ? created.value
    : known.value
      ? { id: known.value.id, name: known.value.name, kind: known.value.kind, install: null }
      : null,
);
const currentKind = computed<Kind>(() => current.value?.kind ?? kind.value);

async function create() {
  createError.value = undefined;
  const value = name.value.trim();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    createError.value = t('clusters.errors.invalidName');
    return;
  }
  creating.value = true;
  try {
    const res = await api<CreateClusterResponse>('/clusters', {
      method: 'POST',
      body: { name: value, kind: kind.value },
    });
    created.value = {
      id: res.cluster.id,
      name: res.cluster.name,
      kind: res.cluster.kind,
      install: res.install,
    };
    startedAt.value = Date.now();
    await router.replace({ name: 'onboarding', query: { id: res.cluster.id } });
    await clusters.load().catch(() => undefined);
    clusters.select(res.cluster.id);
  } catch (err) {
    createError.value = hasProblemType(err, ProblemType.nameTaken)
      ? t('clusters.errors.nameTaken')
      : problemCode(err) === 'plan-limit'
        ? t('cloud.errors.plan-limit')
        : err instanceof ApiError && err.status === 400
          ? t('clusters.errors.invalidName')
          : t('clusters.errors.generic');
  } finally {
    creating.value = false;
  }
}

/** After a reload the token is gone: a new token gives a new command (the old one stays). */
const reissuing = ref(false);
const reissueError = ref(false);
async function reissue() {
  if (!current.value) return;
  reissuing.value = true;
  reissueError.value = false;
  try {
    const res = await api<IssueTokenResponse>(
      `/clusters/${encodeURIComponent(current.value.id)}/tokens`,
      { method: 'POST' },
    );
    created.value = { ...current.value, install: res.install };
  } catch {
    reissueError.value = true;
  } finally {
    reissuing.value = false;
  }
}

// ------------------------------------------------------------------ the commands
const METHODS: Record<Kind, Method[]> = {
  kubernetes: ['helm', 'kubectl'],
  docker: ['dockerRun', 'compose'],
};
const methods = computed(() =>
  METHODS[currentKind.value].filter((m) => !!current.value?.install?.[m]),
);
const method = ref<Method>('helm');
watch(
  methods,
  (list) => {
    if (!list.includes(method.value) && list[0]) method.value = list[0];
  },
  { immediate: true },
);
const command = computed(() => current.value?.install?.[method.value] ?? '');
const { state: copyState, copy } = useCopy();
async function copyCommand() {
  await copy(command.value);
  funnel('install_command_copied', { method: method.value.toLowerCase(), kind: currentKind.value });
}
const tabs = ref<HTMLElement[]>([]);
function onTabKey(e: KeyboardEvent, i: number) {
  const n = methods.value.length;
  const next =
    e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : null;
  if (next === null) return;
  e.preventDefault();
  method.value = methods.value[next]!;
  tabs.value[next]?.focus();
}
/** Where the agents push to, for the troubleshooting's "allow this host". */
const ingestHost = computed(() => {
  const m = /https?:\/\/([^/'"\s:]+)/.exec(current.value?.install?.[methods.value[0]!] ?? '');
  return m?.[1] ?? '';
});

// ------------------------------------------------------------------ the live checklist
const { status } = useOnboardingStatus(
  computed(() => (step.value === 'install' ? clusterId.value : null)),
);
const ready = computed(() => !!status.value?.ready);
const heard = computed(() => status.value?.steps.find((s) => s.id === 'agent')?.state === 'done');
const now = ref(Date.now());
const clock = setInterval(() => (now.value = Date.now()), 5000);
onBeforeUnmount(() => clearInterval(clock));
/** Troubleshooting: after 2 minutes on this page without a heartbeat (SPEC §10.3). */
const troubled = computed(
  () => step.value === 'install' && !heard.value && now.value - startedAt.value >= TROUBLE_AFTER_MS,
);
watch(troubled, (on) => {
  if (on) funnel('onboarding_troubleshooting_shown', { kind: currentKind.value });
});
const helpHref = computed(() => {
  const subject = t('onboarding.trouble.helpSubject');
  const body = t('onboarding.trouble.helpBody', {
    id: current.value?.id ?? '',
    kind: t(`clusters.kind.${currentKind.value}`),
  });
  return `mailto:${auth.cloud?.supportEmail ?? ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});

async function openDashboard() {
  funnel('onboarding_dashboard_opened', { kind: currentKind.value });
  if (current.value) clusters.select(current.value.id);
  await router.push({
    name: 'overview',
    query: current.value ? { cluster: current.value.id } : {},
  });
}
const sampleUrl = computed(() => auth.cloud?.sampleUrl ?? 'https://demo.watchlog.io');
const sampleOpened = () => funnel('onboarding_sample_opened');

// ------------------------------------------------------------------ alerts (optional)
type Channel = 'slack' | 'telegram' | 'email';
const channel = ref<Channel | null>(null);
const channels = ref<AlertChannelList['channels']>([]);
async function loadChannels() {
  try {
    channels.value = (await api<AlertChannelList>('/alert-channels')).channels;
  } catch {
    channels.value = [];
  }
}
watch(ready, (r) => {
  if (r) void loadChannels();
});
const verifiedEmail = computed(() =>
  auth.account?.emailVerified ? auth.account.email : (auth.user?.email ?? ''),
);
const of = (type: string) => channels.value.filter((c) => c.type === type);
const firstChannel = computed(() => channels.value.length === 0);
async function channelAdded() {
  await loadChannels();
}

const steps = computed(() => [
  { id: 'what', state: step.value === 'choose' ? 'current' : 'done' },
  { id: 'install', state: step.value === 'install' ? (ready.value ? 'done' : 'current') : 'next' },
  { id: 'alerts', state: ready.value ? 'current' : 'next' },
]);
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg text-text">
    <header
      class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-border px-4 py-4 md:px-8"
    >
      <span class="flex items-center gap-2.5 text-16 font-semibold tracking-tight">
        <img :src="logoUrl" alt="" class="size-8" />{{ $t('app.name') }}
      </span>
      <ol
        class="flex flex-wrap items-center gap-2 text-14 max-sm:order-last max-sm:w-full"
        :aria-label="$t('onboarding.steps.label')"
      >
        <template v-for="(s, i) in steps" :key="s.id">
          <li v-if="i > 0" aria-hidden="true" class="px-1 text-text-subtle">—</li>
          <li
            :class="[
              'flex items-center gap-2',
              s.state === 'current' ? 'font-semibold text-text' : 'text-text-muted',
            ]"
            :aria-current="s.state === 'current' ? 'step' : undefined"
          >
            <span
              :class="[
                'flex size-6 items-center justify-center rounded-full text-12',
                s.state === 'current'
                  ? 'bg-primary text-on-primary'
                  : s.state === 'done'
                    ? 'bg-primary-soft text-primary'
                    : 'border border-border-strong',
              ]"
              aria-hidden="true"
            >
              <Check v-if="s.state === 'done'" class="size-3.5" />
              <template v-else>{{ i + 1 }}</template>
            </span>
            {{ $t(`onboarding.steps.${s.id}`) }}
            <span v-if="s.state === 'done'" class="sr-only">{{ $t('onboarding.steps.done') }}</span>
          </li>
        </template>
      </ol>
      <span class="max-w-60 truncate text-14 text-text-muted" data-testid="wizard-context">
        {{
          current
            ? `${current.name} · ${$t(`clusters.kind.${current.kind}`)}`
            : (auth.account?.email ?? auth.user?.email)
        }}
      </span>
    </header>

    <!-- 1. What do you want to monitor? -->
    <main
      v-if="step === 'choose'"
      class="mx-auto flex w-full max-w-[920px] flex-1 flex-col gap-8 px-4 py-10 md:px-6 md:py-14"
      data-testid="wizard-choose"
    >
      <div class="flex flex-col gap-2">
        <h1 class="text-24 font-semibold md:text-32">{{ $t('onboarding.choose.title') }}</h1>
        <p class="text-16 text-text-muted">{{ $t('onboarding.choose.intro') }}</p>
      </div>
      <fieldset>
        <legend class="sr-only">{{ $t('onboarding.choose.legend') }}</legend>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label
            v-for="k in ['kubernetes', 'docker'] as const"
            :key="k"
            :data-testid="`kind-${k}`"
            :class="[
              'flex min-h-44 cursor-pointer flex-col gap-3 rounded-card border-2 bg-surface-1 p-5 transition-colors md:p-6',
              'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary',
              kind === k
                ? 'border-primary ring-4 ring-primary-soft'
                : 'border-border hover:border-border-strong',
            ]"
          >
            <input v-model="kind" type="radio" name="kind" :value="k" class="sr-only" />
            <span class="flex w-full items-center justify-between gap-3">
              <span class="flex items-center gap-2.5 text-20 font-semibold">
                <component :is="KIND_LOGO[k]" class="size-6 shrink-0" aria-hidden="true" />
                {{ $t(`onboarding.choose.${k}.title`) }}
              </span>
              <span
                :class="[
                  'size-5 shrink-0 rounded-full',
                  kind === k ? 'border-[6px] border-primary' : 'border-2 border-border-strong',
                ]"
                aria-hidden="true"
              />
            </span>
            <span class="text-14 leading-relaxed text-text-muted">{{
              $t(`onboarding.choose.${k}.body`)
            }}</span>
            <span class="font-mono text-13 text-text-muted">{{
              $t(`onboarding.choose.${k}.how`)
            }}</span>
          </label>
        </div>
      </fieldset>
      <form class="flex flex-col gap-8" novalidate @submit.prevent="create">
        <div class="max-w-[420px]">
          <TextField
            v-model="name"
            :label="$t(`onboarding.choose.name.${kind}`)"
            :hint="$t('onboarding.choose.nameHint')"
            :error="createError"
            required
            :maxlength="63"
            data-testid="cluster-name"
            @update:model-value="nameEdited = true"
          />
        </div>
        <div
          class="flex flex-wrap-reverse items-center justify-between gap-4 border-t border-border pt-6"
        >
          <a
            :href="sampleUrl"
            target="_blank"
            rel="noopener"
            class="inline-flex min-h-11 items-center gap-1.5 text-16 font-medium text-primary hover:text-primary-hover"
            data-testid="sample-link"
            @click="sampleOpened"
          >
            {{ $t('onboarding.sample.first') }}
            <ExternalLink class="size-4" aria-hidden="true" />
            <span class="sr-only">{{ $t('onboarding.sample.newTab') }}</span>
          </a>
          <BaseButton
            type="submit"
            :loading="creating"
            class="max-sm:w-full"
            data-testid="wizard-continue"
          >
            {{ $t('onboarding.choose.continue') }}
          </BaseButton>
        </div>
      </form>
    </main>

    <!-- 2. Install, the live checklist, 3. alerts -->
    <main
      v-else
      class="mx-auto flex w-full max-w-[1200px] flex-1 flex-wrap items-start gap-8 px-4 pt-8 pb-14 md:px-6 md:pt-10"
      data-testid="wizard-install"
    >
      <section class="flex min-w-0 flex-[999_1_600px] flex-col gap-6">
        <div class="flex flex-col gap-2">
          <h1 class="text-24 font-semibold md:text-32">{{ $t('onboarding.install.title') }}</h1>
          <p class="text-16 text-text-muted">
            {{ $t(`onboarding.install.intro.${currentKind}`, { name: current?.name ?? '' }) }}
          </p>
        </div>

        <div
          v-if="current?.install"
          class="overflow-hidden rounded-card border border-border bg-surface-1"
          data-testid="install-commands"
        >
          <div
            role="tablist"
            :aria-label="$t('onboarding.install.methods')"
            class="flex flex-wrap gap-1 border-b border-border p-2"
          >
            <button
              v-for="(m, i) in methods"
              :id="`tab-${m}`"
              :key="m"
              ref="tabs"
              type="button"
              role="tab"
              :aria-selected="method === m"
              :aria-controls="`panel-${m}`"
              :tabindex="method === m ? 0 : -1"
              :data-testid="`tab-${m}`"
              :class="[
                'min-h-11 rounded-control px-4 text-14 transition-colors lg:min-h-9',
                method === m
                  ? 'bg-surface-3 font-semibold text-text'
                  : 'text-text-muted hover:bg-surface-2 hover:text-text',
              ]"
              @click="method = m"
              @keydown="onTabKey($event, i)"
            >
              {{ $t(`onboarding.install.method.${m}`) }}
            </button>
          </div>
          <div
            :id="`panel-${method}`"
            role="tabpanel"
            :aria-labelledby="`tab-${method}`"
            class="flex flex-col gap-3.5 p-4 md:p-5"
          >
            <pre
              class="overflow-x-auto rounded-control border border-border bg-bg px-4 py-3.5 font-mono text-13 leading-relaxed text-text"
              data-testid="install-command"
            ><code>{{ command }}</code></pre>
            <div class="flex flex-wrap items-center justify-between gap-3">
              <span class="text-13 text-text-muted">{{
                $t(`onboarding.install.note.${method}`)
              }}</span>
              <BaseButton variant="secondary" data-testid="copy-command" @click="copyCommand">
                <Check v-if="copyState === 'copied'" class="size-4 text-ok" aria-hidden="true" />
                <span aria-live="polite">{{
                  copyState === 'copied'
                    ? $t('onboarding.install.copied')
                    : copyState === 'failed'
                      ? $t('common.copyFailed')
                      : $t('onboarding.install.copy')
                }}</span>
              </BaseButton>
            </div>
          </div>
        </div>
        <div
          v-else
          class="flex flex-col items-start gap-3 rounded-card border border-border bg-surface-1 p-5"
          data-testid="install-lost"
        >
          <p class="text-14 text-text-muted">{{ $t('onboarding.install.lost') }}</p>
          <p v-if="reissueError" class="text-13 text-critical" role="alert">
            {{ $t('clusters.errors.generic') }}
          </p>
          <BaseButton variant="secondary" :loading="reissuing" @click="reissue">
            {{ $t('onboarding.install.reissue') }}
          </BaseButton>
        </div>

        <!-- 3. Where should alerts go? (optional, once data arrives) -->
        <section
          v-if="ready"
          class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-5 md:p-6"
          data-testid="wizard-alerts"
          aria-labelledby="alerts-title"
        >
          <div class="flex flex-col gap-1.5">
            <h2 id="alerts-title" class="text-20 font-semibold">
              {{ $t('onboarding.alerts.title') }}
            </h2>
            <p class="text-14 text-text-muted">{{ $t('onboarding.alerts.intro') }}</p>
          </div>
          <p
            v-if="channels.length"
            class="flex items-center gap-2 text-14 text-ok"
            data-testid="alerts-set"
          >
            <Check class="size-4" aria-hidden="true" />
            {{ $t('onboarding.alerts.set', { n: channels.length }, channels.length) }}
          </p>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <button
              v-for="c in ['slack', 'telegram', 'email'] as const"
              :key="c"
              type="button"
              :aria-pressed="channel === c"
              :data-testid="`channel-${c}`"
              :class="[
                'flex min-h-11 flex-col gap-1.5 rounded-card border bg-surface-2 p-4 text-left transition-colors hover:bg-surface-3',
                channel === c ? 'border-primary' : 'border-border',
              ]"
              @click="channel = channel === c ? null : c"
            >
              <b class="text-16">{{ $t(`channels.types.${c}`) }}</b>
              <span class="text-13 break-words text-text-muted">{{
                c === 'email'
                  ? auth.account?.emailVerified
                    ? $t('onboarding.alerts.emailVerified', { email: verifiedEmail })
                    : verifiedEmail
                  : $t(`onboarding.alerts.${c}`)
              }}</span>
            </button>
          </div>
          <TypeCard
            v-if="channel === 'slack'"
            type="slack"
            :channels="of('slack')"
            :can-manage="auth.canManage"
            :first-channel="firstChannel"
            @changed="channelAdded"
          />
          <TelegramCard
            v-else-if="channel === 'telegram'"
            :channels="of('telegram')"
            :can-manage="auth.canManage"
            :first-channel="firstChannel"
            @changed="channelAdded"
          />
          <AddChannelForm
            v-else-if="channel === 'email'"
            type="email"
            :first-channel="firstChannel"
            :initial-target="verifiedEmail"
            @created="
              channel = null;
              channelAdded();
            "
            @cancel="channel = null"
          />
        </section>

        <!-- Not connecting after 2 minutes? (SPEC §10.3) -->
        <details
          v-if="troubled"
          open
          class="group rounded-card border border-border bg-surface-1 px-4 py-3 md:px-5"
          data-testid="troubleshooting"
        >
          <summary class="flex min-h-11 cursor-pointer items-center text-16 font-semibold">
            {{ $t('onboarding.trouble.title') }}
          </summary>
          <div class="flex flex-col gap-3 pt-2 pb-2 text-14 leading-relaxed text-text-muted">
            <p>{{ $t('onboarding.trouble.run') }}</p>
            <CodeBlock
              :label="$t('onboarding.trouble.diagnostics')"
              :code="$t(`onboarding.trouble.commands.${currentKind}`)"
            />
            <ul class="flex list-disc flex-col gap-1.5 pl-5">
              <li>
                <b class="text-text">{{ $t('onboarding.trouble.egress.title') }}</b>
                {{ $t('onboarding.trouble.egress.body', { host: ingestHost }) }}
              </li>
              <li>
                <b class="text-text">{{ $t('onboarding.trouble.token.title') }}</b>
                {{ $t('onboarding.trouble.token.body') }}
              </li>
              <template v-if="currentKind === 'kubernetes'">
                <li>
                  <b class="text-text">{{ $t('onboarding.trouble.podSecurity.title') }}</b>
                  {{ $t('onboarding.trouble.podSecurity.body') }}
                  <code class="font-mono break-all text-text"
                    >kubectl label namespace watchlog pod-security.kubernetes.io/enforce=privileged
                    --overwrite</code
                  >
                </li>
              </template>
              <li v-else>
                <b class="text-text">{{ $t('onboarding.trouble.socket.title') }}</b>
                {{ $t('onboarding.trouble.socket.body') }}
              </li>
              <li>
                <b class="text-text">{{ $t('onboarding.trouble.kernel.title') }}</b>
                {{ $t('onboarding.trouble.kernel.body') }}
              </li>
            </ul>
            <a
              :href="helpHref"
              class="inline-flex min-h-11 items-center gap-2 self-start font-semibold text-primary hover:text-primary-hover"
              data-testid="help-installing"
              @click="funnel('onboarding_help_opened', { kind: currentKind })"
            >
              <Mail class="size-4" aria-hidden="true" />{{ $t('onboarding.trouble.help') }}
            </a>
          </div>
        </details>
      </section>

      <aside class="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
        <div class="flex flex-col gap-5 rounded-card border border-border bg-surface-1 p-5 md:p-6">
          <LiveChecklist :status="status" :kind="currentKind" :since="startedAt" />
          <BaseButton
            v-if="ready"
            block
            class="pulse-twice h-12 text-16 max-lg:h-12"
            data-testid="open-dashboard"
            @click="openDashboard"
          >
            {{ $t('onboarding.install.openDashboard') }}
            <ArrowRight class="size-4" aria-hidden="true" />
          </BaseButton>
          <div v-else class="flex flex-col gap-2">
            <span
              class="flex h-12 items-center justify-center rounded-control border border-border bg-surface-2 text-16 font-semibold text-text-muted"
              data-testid="waiting-agent"
              >{{ $t('onboarding.install.waiting') }}</span
            >
            <BaseButton
              variant="ghost"
              block
              data-testid="open-dashboard-early"
              @click="openDashboard"
            >
              {{ $t('onboarding.install.skip') }}
            </BaseButton>
          </div>
        </div>
        <a
          :href="sampleUrl"
          target="_blank"
          rel="noopener"
          class="flex flex-col gap-1 rounded-card border border-border bg-surface-1 px-5 py-4 transition-colors hover:bg-surface-2"
          data-testid="sample-card"
          @click="sampleOpened"
        >
          <b class="text-16 text-text">{{ $t('onboarding.sample.waitTitle') }}</b>
          <span class="flex items-center gap-1.5 text-14 text-primary">
            {{ $t('onboarding.sample.wait') }}
            <ExternalLink class="size-3.5" aria-hidden="true" />
            <span class="sr-only">{{ $t('onboarding.sample.newTab') }}</span>
          </span>
        </a>
      </aside>
    </main>
  </div>
</template>
