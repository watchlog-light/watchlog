<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Check, Copy, Sparkles } from '@lucide/vue';
import type { Causes } from '@watchlog/api-types';
import { computed, onMounted, ref, watch } from 'vue';
import { usePolling } from '@/composables/usePolling';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import CauseChecks from '@/components/causes/CauseChecks.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useCopy } from '@/composables/useCopy';
import { useLoader } from '@/composables/useLoader';
import { causesText, headlineLine, panelState, say } from '@/lib/causes';
import { formatWhen } from '@/lib/format';
import { askCall, causeFacts, type CauseCardState } from '@/lib/what-changed';

// What changed's cause card (ADR-199, the screen Main): the same GET /causes answer as the
// probable-cause panel, in the page's form. A row of what the answer checked, the cause in
// large type beside a rule ("Likely · where it starts"), and three actions: the evidence (the
// panel's own "What we checked" list), the answer as text, and the MCP call that gives your AI
// the same answer. Green only when a cause is likely; no clear cause and couldn't run (no row
// probable cause explains, or the answer failed) keep the same card in a neutral tone.
const props = defineProps<{
  clusterId: string;
  clusterName: string;
  /** GET /causes's subject; null when no row is one probable cause explains. */
  subject: string | null;
  platform: 'kubernetes' | 'docker';
}>();
const { t } = useI18n();
const tr = (key: string, values?: Record<string, unknown>, plural?: number) =>
  plural === undefined ? t(key, values ?? {}) : t(key, values ?? {}, plural);

// The cache behind GET /causes keeps an answer 15 s; the panel refreshes every 30 s too.
const REFRESH_MS = 30_000;
const page = useLoader(() =>
  api<Causes>(
    `/causes?cluster=${encodeURIComponent(props.clusterId)}&subject=${encodeURIComponent(props.subject ?? '')}`,
  ),
);
const a = computed(() => (props.subject ? (page.data.value ?? null) : null));
const state = computed<CauseCardState | null>(() => {
  if (!props.subject) return 'noSubject';
  if (a.value) return panelState(a.value);
  return page.error.value ? 'error' : null;
});
const green = computed(() => state.value === 'likely' || state.value === 'was');
const sentence = computed(() => {
  if (state.value === 'noSubject') return t(`whatChanged.noCause.${props.platform}`);
  if (state.value === 'error') return t('causes.panel.error');
  return a.value ? say(tr, headlineLine(a.value)) : '';
});
const facts = computed(() =>
  a.value ? causeFacts(a.value.checks, !!props.subject?.startsWith('alert:')) : [],
);
const factText = (lines: ReturnType<typeof causeFacts>[number]['lines']) =>
  lines.map((l) => say(tr, l)).join(': ');

const evidence = ref(false);
const ask = ref(false);
const { state: copyState, copy } = useCopy();
function copyText() {
  if (a.value) void copy(causesText(a.value, tr, (iso) => formatWhen(iso)));
}

// Paused while the tab is hidden, spread by ±20 % (ADR-206).
const poll = usePolling(() => (props.subject ? page.load() : undefined), REFRESH_MS);
watch(
  () => [props.clusterId, props.subject],
  () => {
    evidence.value = false;
    ask.value = false;
    if (props.subject) void page.load();
  },
);
onMounted(() => {
  if (!props.subject) return;
  void page.load();
  poll.start();
});
</script>

<template>
  <section
    :class="[
      'flex flex-col gap-5.5 rounded-2xl border p-7 max-md:gap-4.5 max-md:p-4',
      green ? 'wc-cause-ok border-ok/40' : 'border-border bg-surface-1/45',
    ]"
    aria-labelledby="wc-cause-title"
    :data-state="state ?? 'loading'"
    data-testid="wc-cause"
  >
    <div
      class="flex flex-wrap justify-between gap-x-4 gap-y-1 font-mono text-12 tracking-widest uppercase md:text-13"
    >
      <h2 id="wc-cause-title" class="text-text">{{ $t('whatChanged.cause.title') }}</h2>
      <span class="text-text-subtle">{{ $t('whatChanged.cause.rules') }}</span>
    </div>

    <!-- The first second: a skeleton of the facts and the cause. -->
    <div v-if="!state" class="flex flex-col gap-4" aria-busy="true" data-testid="wc-cause-loading">
      <span class="text-14 text-text-muted">{{ $t('causes.panel.loadingAny') }}</span>
      <template v-if="page.skeleton.value">
        <Skeleton class="w-3/5 text-16" />
        <Skeleton class="w-4/5 text-24" />
      </template>
    </div>

    <template v-else>
      <ul
        v-if="facts.length"
        class="flex flex-wrap gap-x-7 gap-y-2.5 text-14 text-text-muted md:text-16"
        :aria-label="$t('whatChanged.cause.facts')"
        data-testid="wc-cause-facts"
      >
        <li
          v-for="(f, i) in facts"
          :key="i"
          class="flex items-start gap-2.5"
          :data-result="f.result"
          data-testid="wc-cause-fact"
        >
          <Check class="mt-1 size-4 shrink-0 text-ok" aria-hidden="true" />
          <span>{{ factText(f.lines) }}</span>
        </li>
      </ul>

      <div class="flex gap-5.5 max-md:gap-4">
        <span
          :class="['w-[3px] shrink-0 rounded-sm', green ? 'bg-ok' : 'bg-border-strong']"
          aria-hidden="true"
        />
        <div class="flex min-w-0 flex-col gap-2.5">
          <span
            :class="[
              'font-mono text-12 tracking-widest uppercase md:text-13',
              green ? 'text-ok' : 'text-text-muted',
            ]"
            data-testid="wc-cause-label"
            >{{ $t(`whatChanged.cause.label.${state}`) }}</span
          >
          <p
            :class="[
              'leading-snug font-medium tracking-tight break-words text-text',
              green ? 'text-20 md:text-24' : 'text-16 md:text-20',
            ]"
            data-testid="wc-cause-sentence"
          >
            {{ sentence }}
          </p>
        </div>
      </div>

      <div v-if="a" class="flex flex-wrap gap-2.5 pt-1" data-testid="wc-cause-actions">
        <button
          type="button"
          class="wc-ghost"
          :aria-expanded="evidence"
          aria-controls="wc-cause-evidence"
          data-testid="wc-cause-evidence-toggle"
          @click="evidence = !evidence"
        >
          {{ $t(evidence ? 'whatChanged.cause.hideEvidence' : 'whatChanged.cause.evidence') }}
        </button>
        <button
          type="button"
          class="wc-ghost"
          :aria-label="$t('whatChanged.cause.copyLabel')"
          data-testid="wc-cause-copy"
          @click="copyText"
        >
          <Check v-if="copyState === 'copied'" class="size-4 text-ok" aria-hidden="true" />
          <Copy v-else class="size-4" aria-hidden="true" />
          {{
            copyState === 'copied'
              ? $t('common.copied')
              : copyState === 'failed'
                ? $t('common.copyFailed')
                : $t('whatChanged.cause.copy')
          }}
        </button>
        <button
          type="button"
          class="wc-ghost"
          :aria-expanded="ask"
          aria-controls="wc-cause-ask"
          data-testid="wc-cause-ask-toggle"
          @click="ask = !ask"
        >
          <Sparkles class="size-4" aria-hidden="true" />
          {{ $t('whatChanged.cause.ask') }}
        </button>
        <span class="sr-only" aria-live="polite">{{
          copyState === 'copied' ? $t('common.copied') : ''
        }}</span>
      </div>
      <button
        v-else-if="state === 'error'"
        type="button"
        class="wc-ghost self-start"
        data-testid="wc-cause-retry"
        @click="page.load"
      >
        {{ $t('whatChanged.cause.retry') }}
      </button>

      <div v-if="a && evidence" id="wc-cause-evidence" data-testid="wc-cause-evidence">
        <CauseChecks :checks="a.checks" open :resolved="state === 'was'" />
      </div>
      <div
        v-if="a && ask && subject"
        id="wc-cause-ask"
        class="flex flex-col gap-2.5"
        data-testid="wc-cause-ask"
      >
        <p class="text-13 text-text-muted">{{ $t('causes.panel.ask.description') }}</p>
        <CodeBlock :label="$t('causes.panel.ask.label')" :code="askCall(subject, clusterName)" />
      </div>
    </template>
  </section>
</template>

<style scoped>
/* The screen's green card: the success tone, a little of it in the background. */
.wc-cause-ok {
  background: color-mix(in srgb, var(--ok) 4%, var(--bg));
}
.wc-ghost {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 0 16px;
  font-size: 14px;
  color: var(--text);
  background: transparent;
}
.wc-ghost:hover {
  background: var(--surface-2);
}
.wc-ghost:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
</style>
