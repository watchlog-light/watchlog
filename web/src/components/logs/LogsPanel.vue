<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Copy, RefreshCw } from '@lucide/vue';
import type { paths } from '@watchlog/api-types';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { API_BASE, api, ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue';
import { useCopy } from '@/composables/useCopy';
import { useAuthStore } from '@/stores/auth';

// Container logs on demand (ADR-167): the last lines of one container, read by its agent
// only when someone asks, redacted there, never stored. One panel for a pod's containers
// (Kubernetes) and a Docker container. The lines live in this component's memory only.
type LogsAnswer =
  paths['/api/v1/clusters/{id}/pods/{namespace}/{name}/logs']['get']['responses'][200]['content']['application/json'];
type LogLine = LogsAnswer['lines'][number];
type Access = 'all' | 'admins' | 'off';

const props = defineProps<{
  kind: 'pod' | 'container';
  clusterId: string;
  /** Kubernetes */
  namespace?: string;
  pod?: string;
  containers?: { name: string; init: boolean }[];
  /** Docker */
  host?: string;
  name?: string;
}>();

const LINE_CHOICES = [100, 200, 500, 1000] as const;
/** Lines kept while following; the oldest go first. */
const MAX_KEPT = 1000;
/** The error codes the panel has words for (backend/src/modules/logs/routes.ts). */
const CODES = [
  'logs_off',
  'logs_admins_only',
  'logs_disabled',
  'container_not_found',
  'no_previous_run',
  'driver_unsupported',
  'read_failed',
  'rate_limited',
  'no_agent',
] as const;
type Code = (typeof CODES)[number];

const { t, n } = useI18n();
const auth = useAuthStore();

const ordered = computed(() => [
  ...(props.containers ?? []).filter((c) => !c.init),
  ...(props.containers ?? []).filter((c) => c.init),
]);
const container = ref(ordered.value[0]?.name ?? '');
watch(ordered, (list) => {
  if (!list.some((c) => c.name === container.value)) container.value = list[0]?.name ?? '';
});
const lines = ref<number>(200);
const previous = ref(false);
const follow = ref(false);
const showTimes = ref(false);

const state = ref<'idle' | 'loading' | 'shown' | 'error'>('idle');
const shown = ref<LogLine[]>([]);
const redacted = ref(0);
const cut = ref(0);
const truncated = ref(false);
const errorCode = ref<Code | null>(null);
const errorDetail = ref<string | null>(null);
const followEnd = ref<'limit' | 'done' | 'error' | null>(null);
const following = ref(false);
const announce = ref('');
const access = ref<Access>('all');

const blocked = computed<Code | null>(() => {
  if (access.value === 'off') return 'logs_off';
  if (access.value === 'admins' && auth.user?.role === 'viewer') return 'logs_admins_only';
  return null;
});

const base = computed(() =>
  props.kind === 'pod'
    ? `/clusters/${props.clusterId}/pods/${encodeURIComponent(props.namespace ?? '')}/${encodeURIComponent(props.pod ?? '')}/logs`
    : `/clusters/${props.clusterId}/docker/hosts/${encodeURIComponent(props.host ?? '')}/containers/${encodeURIComponent(props.name ?? '')}/logs`,
);
function query(withFollow: boolean): string {
  const q = new URLSearchParams({ lines: String(lines.value) });
  if (props.kind === 'pod') {
    if (container.value) q.set('container', container.value);
    if (previous.value) q.set('previous', 'true');
  }
  if (withFollow) q.set('follow', 'true');
  return `${base.value}?${q.toString()}`;
}

function codeOf(err: unknown): Code {
  if (err instanceof ApiError) {
    const code = (err.problem as { code?: string } | undefined)?.code;
    if (code && (CODES as readonly string[]).includes(code)) return code as Code;
    if (err.status === 429) return 'rate_limited';
    if (err.status === 504) return 'no_agent';
    if (err.status === 409) return 'logs_disabled';
  }
  return 'read_failed';
}

function reset() {
  shown.value = [];
  redacted.value = 0;
  cut.value = 0;
  truncated.value = false;
  errorCode.value = null;
  errorDetail.value = null;
  followEnd.value = null;
}

let source: EventSource | null = null;
function stopFollowing() {
  source?.close();
  source = null;
  following.value = false;
}

let seq = 0;
async function read() {
  if (blocked.value) return;
  stopFollowing();
  if (follow.value) {
    startFollowing();
    return;
  }
  const mine = ++seq;
  state.value = 'loading';
  try {
    const a = await api<LogsAnswer>(query(false));
    if (mine !== seq) return;
    reset();
    shown.value = a.lines;
    redacted.value = a.redacted;
    cut.value = a.cut;
    truncated.value = a.truncated;
    state.value = 'shown';
    announce.value = t('logs.announce.loaded', { n: a.lines.length }, a.lines.length);
    await scrollToEnd(true);
  } catch (err) {
    if (mine !== seq) return;
    reset();
    errorCode.value = codeOf(err);
    errorDetail.value = err instanceof ApiError ? (err.problem?.detail ?? null) : null;
    state.value = 'error';
  }
}

function startFollowing() {
  ++seq;
  reset();
  state.value = 'loading';
  following.value = true;
  const es = new EventSource(`${API_BASE}${query(true)}`, { withCredentials: true });
  source = es;
  let received = false;
  es.addEventListener('lines', (ev) => {
    if (source !== es) return;
    const data = JSON.parse((ev as MessageEvent<string>).data) as Omit<
      LogsAnswer,
      'container' | 'previous'
    >;
    const stick = atBottom();
    const all = [...shown.value, ...data.lines];
    // A 5-minute follow keeps the newest lines the panel can hold (ADR-167's 1,000).
    if (all.length > MAX_KEPT) truncated.value = true;
    shown.value = all.length > MAX_KEPT ? all.slice(-MAX_KEPT) : all;
    redacted.value += data.redacted;
    cut.value += data.cut;
    if (data.truncated) truncated.value = true;
    state.value = 'shown';
    if (!received)
      announce.value = t('logs.announce.following', { n: shown.value.length }, shown.value.length);
    received = true;
    void scrollToEnd(stick);
  });
  es.addEventListener('end', (ev) => {
    if (source !== es) return;
    const data = JSON.parse((ev as MessageEvent<string>).data || '{}') as {
      reason?: 'limit' | 'done' | 'error';
      code?: string;
      detail?: string;
    };
    stopFollowing();
    follow.value = false;
    if (data.reason === 'error' && !received) {
      errorCode.value = (CODES as readonly string[]).includes(data.code ?? '')
        ? (data.code as Code)
        : 'read_failed';
      errorDetail.value = data.detail ?? null;
      state.value = 'error';
      return;
    }
    followEnd.value = data.reason ?? 'done';
    state.value = 'shown';
    announce.value = t(`logs.followEnd.${followEnd.value}`);
  });
  // A refusal before the stream opens (403, 409, 429…) arrives as a plain error: read the
  // same URL as JSON once to learn why.
  es.onerror = () => {
    if (source !== es) return;
    stopFollowing();
    follow.value = false;
    if (received) {
      followEnd.value = 'error';
      announce.value = t('logs.followEnd.error');
      return;
    }
    void read();
  };
}

const output = ref<HTMLElement | null>(null);
function atBottom(): boolean {
  const el = output.value;
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}
async function scrollToEnd(force: boolean) {
  await nextTick();
  const el = output.value;
  if (el && force) el.scrollTop = el.scrollHeight;
}

watch(follow, (on) => {
  if (state.value === 'idle') return;
  if (on) startFollowing();
  else stopFollowing();
});
watch([container, previous], () => {
  stopFollowing();
  follow.value = false;
  if (state.value !== 'idle') void read();
});
watch(previous, (p) => {
  if (p) follow.value = false;
});

const { state: copyState, copy } = useCopy();
const copyText = computed(() =>
  shown.value
    .map((l) =>
      [showTimes.value && l.ts ? l.ts : '', l.stream === 'stderr' ? '[stderr]' : '', l.text]
        .filter(Boolean)
        .join(' '),
    )
    .join('\n'),
);

function time(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().replace('T', ' ').slice(0, 23);
}

onMounted(async () => {
  try {
    access.value = (await api<{ access: Access }>('/settings/logs')).access;
  } catch {
    // The route answers per read anyway.
  }
});
onBeforeUnmount(stopFollowing);
</script>

<template>
  <section data-testid="logs-panel" aria-labelledby="logs-title">
    <div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 id="logs-title" class="text-16 font-semibold text-text">{{ $t('logs.title') }}</h3>
      <p class="text-12 text-text-subtle">{{ $t('logs.note') }}</p>
    </div>
    <div class="rounded-card border border-border bg-surface-1">
      <!-- Blocked by the Settings switch: said before anyone asks. -->
      <div v-if="blocked" class="p-5 text-13 text-text-muted" data-testid="logs-blocked">
        <p>{{ $t(`logs.errors.${blocked}`) }}</p>
        <RouterLink
          v-if="auth.canManage"
          :to="{ name: 'settings' }"
          class="mt-2 inline-flex items-center text-primary hover:underline max-lg:min-h-11"
          >{{ $t('logs.openSettings') }}</RouterLink
        >
      </div>
      <template v-else>
        <form
          class="flex flex-wrap items-end gap-3 border-b border-border p-3"
          data-testid="logs-controls"
          @submit.prevent="read"
        >
          <label
            v-if="kind === 'pod' && ordered.length > 1"
            class="flex flex-col gap-1 text-12 text-text-muted"
          >
            {{ $t('logs.container') }}
            <select
              v-model="container"
              class="h-9 rounded-control border border-border bg-surface-2 px-2 text-13 text-text max-lg:h-11"
              data-testid="logs-container"
            >
              <option v-for="c in ordered" :key="c.name" :value="c.name">
                {{ c.init ? $t('logs.initContainer', { name: c.name }) : c.name }}
              </option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-12 text-text-muted">
            {{ $t('logs.lines') }}
            <select
              v-model.number="lines"
              class="h-9 rounded-control border border-border bg-surface-2 px-2 text-13 text-text max-lg:h-11"
              data-testid="logs-lines"
            >
              <option v-for="l in LINE_CHOICES" :key="l" :value="l">{{ n(l) }}</option>
            </select>
          </label>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
            <ToggleSwitch
              v-if="kind === 'pod'"
              v-model="previous"
              class="max-lg:min-h-11"
              data-testid="logs-previous"
              >{{ $t('logs.previous') }}</ToggleSwitch
            >
            <ToggleSwitch
              v-if="kind !== 'pod' || !previous"
              v-model="follow"
              class="max-lg:min-h-11"
              data-testid="logs-follow"
              >{{ $t('logs.follow') }}</ToggleSwitch
            >
            <ToggleSwitch v-model="showTimes" class="max-lg:min-h-11" data-testid="logs-times">{{
              $t('logs.timestamps')
            }}</ToggleSwitch>
          </div>
          <div class="flex flex-wrap items-center gap-2 sm:ml-auto">
            <BaseButton
              type="submit"
              :variant="state === 'idle' ? 'primary' : 'secondary'"
              :loading="state === 'loading'"
              data-testid="logs-read"
            >
              <RefreshCw v-if="state !== 'idle'" class="size-4" aria-hidden="true" />
              {{ state === 'idle' ? $t('logs.show') : $t('logs.refresh') }}
            </BaseButton>
            <BaseButton
              v-if="shown.length > 0"
              variant="ghost"
              data-testid="logs-copy"
              @click="copy(copyText)"
            >
              <Copy class="size-4" aria-hidden="true" />
              {{
                copyState === 'copied'
                  ? $t('logs.copied')
                  : copyState === 'failed'
                    ? $t('logs.copyFailed')
                    : $t('logs.copy')
              }}
            </BaseButton>
          </div>
        </form>

        <div :aria-busy="state === 'loading'" class="text-13">
          <p v-if="state === 'idle'" class="p-5 text-text-muted" data-testid="logs-idle">
            {{ $t('logs.idle') }}
          </p>
          <p
            v-else-if="state === 'loading' && shown.length === 0"
            class="p-5 text-text-muted"
            data-testid="logs-loading"
          >
            {{ following ? $t('logs.connecting') : $t('logs.loading') }}
          </p>
          <div
            v-else-if="state === 'error' && errorCode"
            class="p-5"
            role="alert"
            data-testid="logs-error"
            :data-code="errorCode"
          >
            <p class="text-text">{{ $t(`logs.errors.${errorCode}`) }}</p>
            <p v-if="errorCode === 'no_agent'" class="mt-1 text-text-muted">
              {{ $t('logs.hints.no_agent') }}
            </p>
            <p v-else-if="errorCode === 'logs_disabled'" class="mt-1 text-text-muted">
              {{ $t('logs.hints.logs_disabled') }}
            </p>
            <p v-else-if="errorCode === 'read_failed' && errorDetail" class="mt-1 text-text-muted">
              {{ errorDetail }}
            </p>
            <RouterLink
              v-if="
                (errorCode === 'logs_off' || errorCode === 'logs_admins_only') && auth.canManage
              "
              :to="{ name: 'settings' }"
              class="mt-2 inline-flex items-center text-primary hover:underline max-lg:min-h-11"
              >{{ $t('logs.openSettings') }}</RouterLink
            >
          </div>
          <p v-else-if="shown.length === 0" class="p-5 text-text-muted" data-testid="logs-empty">
            {{ following ? $t('logs.waiting') : $t('logs.empty', { n: n(lines) }) }}
          </p>
          <ol
            v-else
            ref="output"
            class="max-h-[32rem] overflow-y-auto px-3 py-2 font-mono text-12 leading-5"
            tabindex="0"
            :aria-label="$t('logs.outputLabel')"
            data-testid="logs-output"
          >
            <li
              v-for="(l, i) in shown"
              :key="i"
              class="log-line"
              :class="
                l.stream === 'stderr'
                  ? 'border-l-2 border-warning pl-2 text-warning'
                  : 'pl-2.5 text-text'
              "
              :data-stream="l.stream"
              data-testid="log-line"
            >
              <span v-if="l.stream === 'stderr'" class="sr-only">{{ $t('logs.stderr') }}</span>
              <span v-if="showTimes && l.ts" class="mr-2 text-text-subtle">{{ time(l.ts) }}</span
              >{{ l.text }}
            </li>
          </ol>
        </div>

        <div
          v-if="state === 'shown'"
          class="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-12 text-text-muted"
          data-testid="logs-notes"
        >
          <span>{{ $t('logs.count', { n: shown.length }, shown.length) }}</span>
          <span v-if="following" class="text-primary">{{ $t('logs.followingNow') }}</span>
          <span v-if="redacted > 0" data-testid="logs-redacted">{{
            $t('logs.redacted', { n: redacted }, redacted)
          }}</span>
          <span v-if="truncated" data-testid="logs-truncated">{{ $t('logs.truncated') }}</span>
          <span v-if="cut > 0" data-testid="logs-cut">{{ $t('logs.cut', { n: cut }, cut) }}</span>
          <span v-if="followEnd" data-testid="logs-follow-end">{{
            $t(`logs.followEnd.${followEnd}`)
          }}</span>
        </div>
      </template>
      <p class="sr-only" aria-live="polite">{{ announce }}</p>
    </div>
  </section>
</template>

<style scoped>
.log-line {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
