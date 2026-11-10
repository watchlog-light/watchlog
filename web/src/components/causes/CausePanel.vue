<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import {
  ArrowRight,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Minus,
  Route,
  TriangleAlert,
} from '@lucide/vue';
import type { Cause, CauseCheck, Causes } from '@watchlog/api-types';
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { api } from '@/api/client';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useCopy } from '@/composables/useCopy';
import { useLoader } from '@/composables/useLoader';
import {
  causeLine,
  causesText,
  checkLine,
  checksSummary,
  connectorKey,
  headlineLine,
  likelyOf,
  mcpTool,
  objectKind,
  objectLink,
  openKey,
  panelState,
  possibleOf,
  say,
  sourceKey,
  stepLine,
  stepTime,
} from '@/lib/causes';
import { formatWhen } from '@/lib/format';
import { since } from '@/lib/time';
import CauseChip from './CauseChip.vue';
import CauseObjectLogo from './CauseObjectLogo.vue';

// The probable-cause panel (ADR-146 to ADR-148, the v0.4 mock-ups): GET /causes for one
// subject, in this order: the headline, the likely cause's chain (at most 3 steps, the
// symptom on top, where it starts last), the other causes, "What we checked" (closed when
// a cause is likely, open when none is clear), and the footer with the MCP tool that gives
// the same answer. Every sentence is a code with facts, worded through en.json (ADR-147).
// `compact` is the service-map edge panel's form (and fits a phone): the headline and the
// chain only. `quiet` hides the panel on an object with nothing to explain (a healthy pod).
const props = defineProps<{
  clusterId: string;
  /** In GET /causes's form: `alert:<id>`, `pod:<ns>/<name>`, `edge:<id>`… */
  subject: string;
  /** What is checked, for the loading line. */
  name?: string;
  compact?: boolean;
  quiet?: boolean;
}>();
const emit = defineEmits<{ answer: [a: Causes | null] }>();
const { t } = useI18n();
const tr = (key: string, values?: Record<string, unknown>, plural?: number) =>
  plural === undefined ? t(key, values ?? {}) : t(key, values ?? {}, plural);

// The cache behind GET /causes keeps an answer 15 s; the pages refresh every 30 s.
const REFRESH_MS = 30_000;
const page = useLoader(() =>
  api<Causes>(
    `/causes?cluster=${encodeURIComponent(props.clusterId)}&subject=${encodeURIComponent(props.subject)}`,
  ),
);
const a = computed(() => page.data.value ?? null);
const state = computed(() => (a.value ? panelState(a.value) : null));
const top = computed(() => (a.value ? likelyOf(a.value) : null));
const others = computed<Cause[]>(() => (a.value ? possibleOf(a.value) : []));
const steps = computed(() => top.value?.chain ?? []);
const time = (iso: string) => formatWhen(iso);

/** Nothing to explain: no symptom, no cause and nothing abnormal among the checks. */
const nothing = computed(
  () =>
    !!a.value &&
    a.value.state === 'none' &&
    !a.value.symptomSince &&
    !a.value.resolvedAt &&
    !a.value.checks.some((c) => c.result === 'explains' || c.result === 'possible'),
);
const hidden = computed(() => props.quiet && (nothing.value || (!a.value && !!page.error.value)));

const checks = computed(() => a.value?.checks ?? []);
const summary = computed(() =>
  checksSummary(checks.value, state.value === 'was')
    .map((l) => say(tr, l))
    .join(', '),
);
const checksOpen = computed(() => a.value?.state === 'none');
const flowsNodes = computed(() => (a.value?.flowsOff ?? []).map((f) => f.node).join(', '));
const meta = computed(() => {
  const x = a.value;
  if (!x) return '';
  if (x.resolvedAt) return t('causes.panel.resolvedMeta', { at: time(x.resolvedAt) });
  const ago = since(x.checkedAt);
  return ago === '0s' ? t('causes.panel.checkedNow') : t('causes.panel.checked', { ago });
});

const CHECK_ICON: Record<CauseCheck['result'], { icon: typeof Check; class: string }> = {
  explains: { icon: CircleCheck, class: 'text-info' },
  ok: { icon: Check, class: 'text-ok' },
  possible: { icon: CircleAlert, class: 'text-warning' },
  not_run: { icon: CircleAlert, class: 'text-warning' },
  not_applicable: { icon: Minus, class: 'text-text-subtle' },
};

const { state: copyState, copy } = useCopy();
function copyText() {
  if (a.value) void copy(causesText(a.value, tr, time));
}

let timer: ReturnType<typeof setInterval> | undefined;
watch(
  () => [props.clusterId, props.subject],
  () => void page.load(),
);
watch(a, (v) => emit('answer', v));
onMounted(() => {
  void page.load();
  timer = setInterval(() => void page.load(), REFRESH_MS);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <section
    v-if="!hidden"
    :aria-labelledby="`cause-title-${subject}`"
    :class="[
      'overflow-hidden rounded-card border bg-surface-1',
      state === 'likely' ? 'border-info/35' : 'border-border',
    ]"
    :data-state="state ?? (page.error.value ? 'error' : 'loading')"
    :data-compact="compact ? 'true' : undefined"
    data-testid="cause-panel"
  >
    <header
      :class="[
        'flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border',
        compact ? 'px-3.5 py-3' : 'px-4.5 py-3.5 max-md:px-4',
      ]"
    >
      <Route class="size-4.5 shrink-0 text-info" aria-hidden="true" />
      <h2 :id="`cause-title-${subject}`" class="text-14 font-semibold text-text">
        {{ $t(`causes.panel.title.${state ?? 'likely'}`) }}
      </h2>
      <CauseChip v-if="state" :state="state" />
      <span v-if="meta" class="ml-auto text-12 text-text-muted" data-testid="cause-meta">{{
        meta
      }}</span>
      <button
        v-if="a && !compact"
        type="button"
        class="inline-flex h-8 items-center gap-1.5 rounded-control border border-border-strong bg-surface-2 px-2.5 text-12 font-medium text-text hover:bg-surface-3 max-lg:min-h-11"
        :class="{ 'ml-auto': !meta }"
        :aria-label="$t('causes.panel.copyLabel')"
        data-testid="cause-copy"
        @click="copyText"
      >
        <Check v-if="copyState === 'copied'" class="size-3.5 text-ok" aria-hidden="true" />
        <Copy v-else class="size-3.5" aria-hidden="true" />
        {{
          copyState === 'copied'
            ? $t('common.copied')
            : copyState === 'failed'
              ? $t('common.copyFailed')
              : $t('causes.panel.copy')
        }}
      </button>
      <span class="sr-only" aria-live="polite">{{
        copyState === 'copied' ? $t('common.copied') : ''
      }}</span>
    </header>

    <!-- The first 1–2 s: a skeleton of the headline and two steps. -->
    <div
      v-if="!a && !page.error.value"
      :class="['flex flex-col gap-3.5', compact ? 'p-3.5' : 'p-4.5 max-md:p-4']"
      aria-busy="true"
      data-testid="cause-loading"
    >
      <span class="text-13 text-text-muted">{{
        name ? $t('causes.panel.loading', { name }) : $t('causes.panel.loadingAny')
      }}</span>
      <div v-if="page.skeleton.value" class="flex flex-col gap-2.5">
        <Skeleton class="w-4/5 text-14" />
        <Skeleton class="w-3/5 text-14" />
        <div class="flex flex-col gap-2.5 pl-10">
          <Skeleton shape="rect" class="h-14 w-full" />
          <Skeleton shape="rect" class="h-14 w-full" />
        </div>
      </div>
    </div>

    <!-- Never breaks the page: one line and a retry. -->
    <div
      v-else-if="!a"
      class="flex flex-wrap items-center gap-3 px-4.5 py-3.5 text-13 text-text-muted max-md:px-4"
      role="status"
      data-testid="cause-error"
    >
      <CircleAlert class="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
      <span class="min-w-0 flex-1">{{ $t('causes.panel.error') }}</span>
      <button
        type="button"
        class="inline-flex h-8 items-center rounded-control border border-border-strong px-3 text-13 font-medium text-text hover:bg-surface-2 max-lg:min-h-11"
        data-testid="cause-retry"
        @click="page.load"
      >
        {{ $t('common.retry') }}
      </button>
    </div>

    <template v-else>
      <div :class="['flex flex-col gap-4', compact ? 'p-3.5' : 'p-4.5 max-md:p-4']">
        <div
          v-if="a.flowsOff?.length"
          class="flex items-start gap-2.5 rounded-card border border-warning/40 bg-warning/5 px-3.5 py-3 text-13 text-text"
          role="note"
          data-testid="cause-flows-off"
        >
          <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            {{ $t('causes.panel.flowsOff', { nodes: flowsNodes, name: a.subject.name }) }}
            <RouterLink
              :to="{ name: 'service-map', query: { cluster: clusterId } }"
              class="text-text underline hover:text-warning"
              >{{ $t('causes.panel.flowsOffLink') }}</RouterLink
            >
          </span>
        </div>

        <p
          :class="['leading-normal font-medium text-text', compact ? 'text-14' : 'text-16']"
          data-testid="cause-headline"
        >
          {{ say(tr, headlineLine(a)) }}
        </p>

        <ol
          v-if="steps.length"
          class="flex flex-col"
          :aria-label="$t('causes.panel.chain')"
          data-testid="cause-chain"
        >
          <li
            v-for="(s, i) in steps"
            :key="i"
            class="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3"
            data-testid="cause-step"
          >
            <div class="flex flex-col items-center">
              <span
                :class="[
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-12 font-semibold',
                  i === steps.length - 1
                    ? state === 'was'
                      ? 'bg-info/50 text-bg'
                      : 'bg-info text-bg'
                    : 'border border-border-strong text-text-muted',
                ]"
                aria-hidden="true"
                >{{ i + 1 }}</span
              >
              <span v-if="i < steps.length - 1" class="block min-h-3.5 w-0.5 flex-1 bg-border" />
            </div>
            <div class="flex min-w-0 flex-col gap-1.5">
              <div
                :class="[
                  'flex flex-col gap-1.5 rounded-card border',
                  compact ? 'px-3 py-2.5' : 'px-3.5 py-3',
                  i === steps.length - 1
                    ? state === 'was'
                      ? 'border-border-strong bg-surface-2'
                      : 'border-info/45 bg-info/5'
                    : 'border-border bg-bg',
                ]"
              >
                <span class="sr-only">{{ $t('causes.panel.step', { n: i + 1 }) }}</span>
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <CauseObjectLogo :object="s.object" />
                  <span class="min-w-0 font-mono text-13 font-medium break-all text-text">{{
                    s.object.name
                  }}</span>
                  <span class="text-12 text-text-muted">{{ say(tr, objectKind(s.object)) }}</span>
                  <span
                    class="ml-auto inline-flex h-5 items-center rounded-[5px] border border-border px-1.5 text-12 text-text-muted"
                    data-testid="cause-source"
                    >{{ $t(sourceKey(s)) }}</span
                  >
                </div>
                <span class="text-14 leading-normal text-text" data-testid="cause-fact">{{
                  say(tr, stepLine(s))
                }}</span>
                <div class="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-12 text-text-muted">
                  <span v-if="stepTime(s, time)" class="font-mono tabular">{{
                    say(tr, stepTime(s, time)!)
                  }}</span>
                  <span
                    v-if="i === steps.length - 1"
                    class="font-semibold text-info"
                    data-testid="cause-root"
                    >{{ $t('causes.panel.root') }}</span
                  >
                  <RouterLink
                    v-if="objectLink(s.object, clusterId)"
                    :to="objectLink(s.object, clusterId)!"
                    class="ml-auto inline-flex min-h-6 items-center gap-1 text-text-muted hover:text-text hover:underline max-lg:min-h-11"
                    data-testid="cause-link"
                    >{{ $t(openKey(s.object)) }} <ArrowRight class="size-3.5" aria-hidden="true"
                  /></RouterLink>
                </div>
              </div>
              <span
                v-if="i < steps.length - 1 && connectorKey(s)"
                class="pt-0.5 pb-1 font-mono text-11 font-medium tracking-wider text-text-muted uppercase"
                data-testid="cause-hop"
                >{{ $t(connectorKey(s)!) }}</span
              >
            </div>
          </li>
        </ol>

        <div v-if="!compact && others.length" class="flex flex-col gap-2" data-testid="cause-also">
          <h3 class="text-12 font-semibold tracking-wider text-text-muted uppercase">
            {{ top ? $t('causes.panel.also') : $t('causes.panel.leads') }}
          </h3>
          <div
            v-for="(c, i) in others"
            :key="i"
            class="flex flex-col gap-1.5 rounded-card border border-dashed border-border-strong bg-bg px-3.5 py-3"
            data-testid="cause-possible"
          >
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <CauseChip state="possible" />
              <CauseObjectLogo
                v-if="c.chain.length"
                :object="c.chain[c.chain.length - 1]!.object"
              />
              <span
                v-if="c.chain.length"
                class="min-w-0 font-mono text-13 font-medium break-all text-text"
                >{{ c.chain[c.chain.length - 1]!.object.name }}</span
              >
              <span class="text-14 leading-normal text-text">{{ say(tr, causeLine(c)) }}</span>
            </div>
            <!-- Where it would start, in its own words. -->
            <span
              v-if="c.chain.length"
              class="text-13 leading-normal text-text-muted"
              data-testid="cause-possible-fact"
              >{{ say(tr, stepLine(c.chain[c.chain.length - 1]!)) }}</span
            >
            <div class="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-12 text-text-muted">
              <span v-if="c.chain.length">{{ $t(sourceKey(c.chain[c.chain.length - 1]!)) }}</span>
              <span v-if="c.since" class="font-mono tabular">{{
                $t('causes.panel.possibleSince', { time: time(c.since) })
              }}</span>
              <RouterLink
                v-if="c.chain.length && objectLink(c.chain[c.chain.length - 1]!.object, clusterId)"
                :to="objectLink(c.chain[c.chain.length - 1]!.object, clusterId)!"
                class="ml-auto inline-flex min-h-6 items-center gap-1 text-text-muted hover:text-text hover:underline max-lg:min-h-11"
                >{{ $t(openKey(c.chain[c.chain.length - 1]!.object)) }}
                <ArrowRight class="size-3.5" aria-hidden="true"
              /></RouterLink>
            </div>
          </div>
        </div>

        <p
          v-if="a.resolvedAt"
          class="flex items-center gap-2.5 rounded-card border border-ok/30 bg-ok/5 px-3 py-2.5 text-13 text-text"
          data-testid="cause-resolved"
        >
          <Check class="size-4 shrink-0 text-ok" aria-hidden="true" />
          {{ $t('causes.panel.resolved', { time: time(a.resolvedAt) }) }}
        </p>

        <details
          v-if="!compact && checks.length"
          :open="checksOpen"
          class="group rounded-card border border-border bg-bg px-3.5"
          data-testid="cause-checks"
        >
          <summary
            class="flex min-h-11 cursor-pointer items-center gap-2 text-13 font-medium text-text marker:text-text-muted"
          >
            {{ $t('causes.panel.checks') }}
            <span class="font-normal text-text-muted">· {{ summary }}</span>
          </summary>
          <ul class="flex flex-col gap-2 pb-3.5">
            <li
              v-for="(c, i) in checks"
              :key="i"
              class="grid grid-cols-[1rem_minmax(0,1fr)] gap-2.5 text-13 leading-normal text-text-muted"
              data-testid="cause-check"
              :data-result="c.result"
            >
              <component
                :is="CHECK_ICON[c.result].icon"
                :class="['mt-0.5 size-3.5', CHECK_ICON[c.result].class]"
                aria-hidden="true"
              />
              <span>
                <span class="sr-only">{{ $t(`causes.panel.checkResult.${c.result}`) }}: </span>
                <span class="text-text">{{ say(tr, checkLine(c).what) }}</span>
                — {{ say(tr, checkLine(c).result) }}
              </span>
            </li>
          </ul>
        </details>
      </div>

      <footer
        v-if="!compact"
        class="flex flex-wrap gap-x-4.5 gap-y-1.5 border-t border-border px-4.5 py-2.5 text-12 text-text-muted max-md:px-4"
        data-testid="cause-footer"
      >
        <span>{{ $t('causes.panel.footer') }}</span>
        <span class="ml-auto"
          >{{ $t('causes.panel.tool') }}
          <code class="font-mono text-text">{{ mcpTool(subject) }}</code></span
        >
      </footer>
    </template>
  </section>
</template>
