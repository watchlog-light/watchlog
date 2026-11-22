<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronLeft, ChevronRight, Copy, Check as CheckIcon, Sparkles } from '@lucide/vue';
import type { CauseCheck, WhatChanged, WhatChangedStory } from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import CauseChecks from '@/components/causes/CauseChecks.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import { useCopy } from '@/composables/useCopy';
import { causeLine, checkLine, headlineLine, say } from '@/lib/causes';
import { askCall, hhmm, metricText, objectLink, valueText } from '@/lib/what-changed';
import {
  changeCauseText,
  changeFactsOf,
  changePhrase,
  episodeLabel,
  factorText,
  foundChecks,
  orderedChecks,
  rowFactor,
  sentenceStart,
  sortedMoved,
  sparkOf,
  storyAsText,
  storyText,
  whoOf,
} from '@/lib/what-changed-story';

// The selected episode (0.14.0, ADR-231): the story in one sentence with its cause, how it
// spread (the change, then each series in the order it moved, arrows only along calls on the
// service map or a shared node or server), what moved against its usual band, and why we think
// so (every check, what changed around then, the evidence, the text, the MCP call).
const props = defineProps<{
  answer: WhatChanged & { story: WhatChangedStory };
  kind: 'kubernetes' | 'server';
  clusterId: string;
  clusterName: string;
  focus: string | null;
}>();
const emit = defineEmits<{ select: [fromIso: string] }>();
const { t } = useI18n();
const tr = (k: string, v?: Record<string, unknown>, n?: number) =>
  n === undefined ? t(k, v ?? {}) : t(k, v ?? {}, n);
const clock = (iso: string) => hhmm(iso);

const story = computed(() => props.answer.story);
const episodes = computed(() => props.answer.episodes);
const index = computed(() => props.answer.episode);
const ep = computed(() => episodes.value[index.value]!);
const label = computed(() => episodeLabel(ep.value, Date.now(), tr, clock));
const sentence = computed(() => storyText(story.value.clauses, tr));
const likely = computed(() => props.answer.cause.likely);
const causeText = computed(() => {
  if (story.value.cause.state === 'likely' && likely.value) {
    return `${say(tr, headlineLine(likely.value))} ${say(tr, causeLine(likely.value))}`.trim();
  }
  if (story.value.cause.state === 'change' && story.value.cause.change) {
    return changeCauseText(story.value.cause.change, tr, clock);
  }
  return '';
});
const found = computed(() => foundChecks(story.value.checks));
const checkText = (c: Pick<CauseCheck, 'topic' | 'code' | 'facts'>) => {
  const l = checkLine(c);
  return { what: say(tr, l.what), result: say(tr, l.result) };
};

// How it spread.
const rowById = computed(() => new Map(story.value.rows.map((r) => [r.id, r])));
const showAllChain = ref(false);
const extra = computed(() => {
  const inChain = new Set(story.value.chain.nodes.map((n) => n.rowId));
  return story.value.rows.filter((r) => !inChain.has(r.id));
});
const seriesCount = computed(
  () => story.value.chain.nodes.filter((n) => n.kind !== 'change').length,
);
const sameTime = computed(() => !story.value.chain.linked && seriesCount.value > 1);
type Node = WhatChangedStory['chain']['nodes'][number];
const nodeKind = (n: Node) =>
  n.kind === 'change' && story.value.change
    ? t(`whatChanged.spread.kind.${story.value.change.kind}`)
    : t(`whatChanged.spread.${n.kind === 'first' ? 'first' : 'then'}`);
const nodeWhat = (n: Node) => {
  if (n.kind === 'change') {
    const c = story.value.change!;
    const from = c.facts.from;
    const to = c.facts.to;
    if (from !== null && from !== undefined && to !== null && to !== undefined) {
      return t('whatChanged.spread.fromTo', { from: String(from), to: String(to) });
    }
    return c.host ? t('whatChanged.spread.on', { host: c.host }) : '';
  }
  const r = n.rowId ? rowById.value.get(n.rowId) : undefined;
  return r ? metricText(r, tr) : '';
};
const nodeValue = (n: Node) => {
  if (n.kind === 'change') return clock(n.at);
  const r = n.rowId ? rowById.value.get(n.rowId) : undefined;
  if (!r) return '';
  const f = rowFactor(r.value, r.usualLow, r.usualHigh);
  return factorText(f.x, f.dir, tr);
};

// What moved.
const sort = ref<'first' | 'furthest'>('first');
const moved = computed(() => {
  const list = sortedMoved(story.value.rows, sort.value);
  return props.focus
    ? list.filter((r) => whoOf(r.object) === props.focus || r.object.name === props.focus)
    : list;
});
const sparkFor = (id: string) => story.value.spark.find((s) => s.rowId === id);
const rel = (iso: string) =>
  Math.max(0, Math.round((Date.parse(iso) - Date.parse(ep.value.from)) / 60_000));

// Why we think so.
const checks = computed(() =>
  orderedChecks(story.value.checks).filter((c) => c.result !== 'not_run'),
);
const evidence = ref(false);
const ask = ref(false);
const { state: copyState, copy } = useCopy();
function copyText() {
  void copy(storyAsText(story.value, label.value, sentence.value, causeText.value, tr));
}
const askText = computed(() =>
  props.answer.cause.subject
    ? askCall(props.answer.cause.subject, props.clusterName)
    : `get_what_changed(cluster: ${JSON.stringify(props.clusterName)}, from: ${Math.floor(Date.parse(ep.value.from) / 1000)})`,
);
watch(index, () => {
  evidence.value = false;
  ask.value = false;
  showAllChain.value = false;
});
const goto = (i: number) => {
  const e = episodes.value[i];
  if (e) emit('select', e.from);
};
</script>

<template>
  <!-- The story. -->
  <section
    class="flex flex-col gap-3 rounded-2xl border border-border bg-surface-1/45 px-6 py-5 max-md:px-4"
    aria-labelledby="wc-story-sentence"
    data-testid="wc-story"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <span
        class="font-mono text-12 tracking-wider text-text-muted uppercase"
        data-testid="wc-story-label"
        >{{ label }}</span
      >
      <div
        v-if="episodes.length > 1"
        class="flex items-center gap-1"
        role="group"
        :aria-label="$t('whatChanged.episode.switcher')"
        data-testid="wc-episodes"
      >
        <button
          type="button"
          class="inline-flex size-8 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 disabled:opacity-40 max-lg:size-11"
          :aria-label="$t('whatChanged.episode.prev')"
          :disabled="index <= 0"
          data-testid="wc-episode-prev"
          @click="goto(index - 1)"
        >
          <ChevronLeft class="size-4" aria-hidden="true" />
        </button>
        <span class="font-mono text-12 text-text-muted" data-testid="wc-episode-of">{{
          $t('whatChanged.episode.of', { i: index + 1, n: episodes.length })
        }}</span>
        <button
          type="button"
          class="inline-flex size-8 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 disabled:opacity-40 max-lg:size-11"
          :aria-label="$t('whatChanged.episode.next')"
          :disabled="index >= episodes.length - 1"
          data-testid="wc-episode-next"
          @click="goto(index + 1)"
        >
          <ChevronRight class="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
    <h3
      id="wc-story-sentence"
      class="text-20 leading-snug font-semibold text-text max-md:text-17"
      data-testid="wc-story-sentence"
    >
      {{ sentence }}
    </h3>
    <div
      v-if="story.cause.state !== 'none'"
      class="flex flex-col gap-1 rounded-card border border-ok/40 bg-ok/10 px-4 py-3"
      data-testid="wc-cause-box"
      data-state="likely"
    >
      <span class="text-12 font-semibold tracking-wider text-ok-text uppercase">{{
        $t('whatChanged.causeBox.likely')
      }}</span>
      <span class="text-14 leading-relaxed text-text">{{ causeText }}</span>
    </div>
    <div
      v-else
      class="flex flex-col gap-1.5 rounded-card border border-border bg-surface-2/60 px-4 py-3"
      data-testid="wc-cause-box"
      data-state="none"
    >
      <span class="text-12 font-semibold tracking-wider text-text-muted uppercase">{{
        $t('whatChanged.causeBox.none')
      }}</span>
      <template v-if="found.length">
        <span class="text-13 text-text-muted">{{ $t('whatChanged.causeBox.found') }}</span>
        <ul class="flex flex-col gap-0.5 text-14 text-text" data-testid="wc-cause-found">
          <li v-for="(c, i) in found" :key="i">
            <span class="text-text-muted">{{ checkText(c).what }}:</span> {{ checkText(c).result }}
          </li>
        </ul>
      </template>
      <span v-else class="text-14 text-text-muted">{{
        $t('whatChanged.causeBox.nothingFound')
      }}</span>
    </div>
  </section>

  <!-- How it spread. -->
  <section
    class="flex flex-col gap-3 rounded-2xl border border-border bg-surface-1/45 px-6 py-5 max-md:px-4"
    aria-labelledby="wc-spread-title"
    data-testid="wc-spread"
  >
    <h3 id="wc-spread-title" class="text-15 font-semibold text-text">
      {{ $t('whatChanged.spread.title') }}
      <span class="font-normal text-text-muted max-md:hidden"
        >·
        {{
          kind === 'server' ? $t('whatChanged.spread.hintFleet') : $t('whatChanged.spread.hint')
        }}</span
      >
    </h3>
    <p v-if="sameTime" class="text-13 text-text-muted" data-testid="wc-spread-same-time">
      {{ $t('whatChanged.spread.sameTime') }}
    </p>
    <ol class="flex flex-wrap items-stretch gap-y-3 max-sm:flex-col" data-testid="wc-chain">
      <li v-for="(n, i) in story.chain.nodes" :key="i" class="flex items-stretch max-sm:flex-col">
        <span
          v-if="i > 0"
          class="flex min-w-14 flex-col items-center justify-center px-1.5 text-center max-sm:min-h-7 max-sm:flex-row max-sm:gap-2"
          aria-hidden="true"
        >
          <span class="font-mono text-12 text-text-muted">+{{ n.gapMin }} min</span>
          <span :class="['text-16', n.linked ? 'text-text-muted' : 'text-transparent']">{{
            n.linked ? '→' : '·'
          }}</span>
        </span>
        <span
          :class="[
            'flex min-w-44 flex-col gap-0.5 rounded-card border px-3.5 py-3',
            n.kind === 'change' ? 'border-info/45 bg-info/10' : 'border-warning/45 bg-surface-2',
          ]"
          data-testid="wc-chain-node"
          :data-kind="n.kind"
        >
          <span
            :class="[
              'font-mono text-11 tracking-widest uppercase',
              n.kind === 'change' ? 'text-info-text' : 'text-warning-text',
            ]"
            >{{ nodeKind(n) }}</span
          >
          <span class="font-mono text-14 font-semibold text-text [overflow-wrap:anywhere]">{{
            n.who
          }}</span>
          <span class="text-13 text-text-muted">{{ nodeWhat(n) }}</span>
          <span
            :class="[
              'font-mono text-14 font-semibold',
              n.kind === 'change' ? 'text-info-text' : 'text-warning-text',
            ]"
            >{{ nodeValue(n) }}</span
          >
        </span>
      </li>
    </ol>
    <template v-if="story.chain.more > 0">
      <button
        type="button"
        class="self-start rounded-control px-2 py-1 text-13 font-medium text-link hover:bg-surface-2 max-lg:min-h-11"
        :aria-expanded="showAllChain"
        data-testid="wc-chain-more"
        @click="showAllChain = !showAllChain"
      >
        {{
          showAllChain
            ? $t('whatChanged.spread.less')
            : $t('whatChanged.spread.more', { n: story.chain.more }, story.chain.more)
        }}
      </button>
      <ul
        v-if="showAllChain"
        class="flex flex-col gap-1 text-13 text-text-muted"
        data-testid="wc-chain-rest"
      >
        <li v-for="r in extra" :key="r.id">
          <span class="font-mono">{{ clock(r.since) }}</span> · {{ whoOf(r.object) }} ·
          {{ metricText(r, tr) }}
        </li>
      </ul>
    </template>
  </section>

  <!-- What moved, and why we think so. -->
  <div class="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4 max-lg:grid-cols-1">
    <section
      class="flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-surface-1/45 px-6 py-5 max-md:px-4"
      aria-labelledby="wc-moved-title"
      data-testid="wc-moved"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 id="wc-moved-title" class="text-15 font-semibold text-text">
          {{ $t('whatChanged.moved.title') }}
        </h3>
        <div
          class="inline-flex gap-0.5 rounded-[7px] border border-border bg-surface-2 p-0.5"
          role="group"
          :aria-label="$t('whatChanged.sort.label')"
          data-testid="wc-moved-sort"
        >
          <button
            v-for="s in ['first', 'furthest'] as const"
            :key="s"
            type="button"
            :class="[
              'rounded-[5px] px-2.5 py-0.5 text-12 max-lg:min-h-11 max-lg:px-3.5',
              sort === s ? 'bg-surface-3 text-text' : 'text-text-muted hover:text-text',
            ]"
            :aria-pressed="sort === s"
            @click="sort = s"
          >
            {{ $t(`whatChanged.sort.${s}`) }}
          </button>
        </div>
      </div>
      <ul class="flex flex-col" data-testid="wc-moved-rows">
        <li
          v-for="r in moved"
          :key="r.id"
          class="border-t border-border first:border-t-0"
          data-testid="wc-moved-row"
        >
          <component
            :is="objectLink(r.object, clusterId) ? 'RouterLink' : 'div'"
            :to="objectLink(r.object, clusterId)"
            class="grid grid-cols-[3.5rem_minmax(0,1fr)_210px_6.5rem] items-center gap-3 py-2.5 hover:bg-surface-2/50 max-md:grid-cols-[3rem_minmax(0,1fr)_auto] max-md:gap-x-2 max-md:gap-y-1.5"
          >
            <span class="flex flex-col font-mono text-12">
              <span class="text-text">{{ clock(r.since) }}</span>
              <span class="text-text-subtle">{{
                $t('whatChanged.moved.rel', { n: rel(r.since) })
              }}</span>
            </span>
            <span class="flex min-w-0 flex-col">
              <span class="font-mono text-13 font-semibold text-text [overflow-wrap:anywhere]">{{
                whoOf(r.object)
              }}</span>
              <span class="text-12 text-text-muted">{{ metricText(r, tr) }}</span>
            </span>
            <svg
              v-if="sparkFor(r.id) && sparkOf(sparkFor(r.id)!, r.usualLow, r.usualHigh, r.since)"
              width="210"
              height="44"
              viewBox="0 0 210 44"
              class="max-md:col-span-3 max-md:w-full"
              preserveAspectRatio="none"
              role="img"
              :aria-label="
                $t('whatChanged.moved.sparkAria', {
                  who: whoOf(r.object),
                  what: metricText(r, tr),
                  range: `${valueText(r.usualLow, r.unit)}–${valueText(r.usualHigh, r.unit)}`,
                  value: valueText(r.value, r.unit),
                })
              "
              data-testid="wc-spark"
            >
              <rect
                x="0"
                :y="sparkOf(sparkFor(r.id)!, r.usualLow, r.usualHigh, r.since)!.band.y"
                width="210"
                :height="sparkOf(sparkFor(r.id)!, r.usualLow, r.usualHigh, r.since)!.band.h"
                class="fill-text-muted/15"
              />
              <line
                v-if="sparkOf(sparkFor(r.id)!, r.usualLow, r.usualHigh, r.since)!.exitX !== null"
                :x1="sparkOf(sparkFor(r.id)!, r.usualLow, r.usualHigh, r.since)!.exitX!"
                :x2="sparkOf(sparkFor(r.id)!, r.usualLow, r.usualHigh, r.since)!.exitX!"
                y1="0"
                y2="44"
                class="stroke-text-subtle"
                stroke-dasharray="3 3"
              />
              <path
                :d="sparkOf(sparkFor(r.id)!, r.usualLow, r.usualHigh, r.since)!.path"
                fill="none"
                class="stroke-warning"
                stroke-width="1.6"
                vector-effect="non-scaling-stroke"
              />
            </svg>
            <span v-else class="h-11 max-md:col-span-3" />
            <span class="flex flex-col items-end gap-1 max-md:row-start-1 max-md:col-start-3">
              <span class="font-mono text-13 text-text">{{ valueText(r.value, r.unit) }}</span>
              <span
                :class="[
                  'rounded-[6px] px-2 py-0.5 text-12 font-bold whitespace-nowrap',
                  rowFactor(r.value, r.usualLow, r.usualHigh).dir === 'up'
                    ? 'bg-warning/15 text-warning-text'
                    : 'bg-info/15 text-info-text',
                ]"
                data-testid="wc-factor"
                >{{
                  factorText(
                    rowFactor(r.value, r.usualLow, r.usualHigh).x,
                    rowFactor(r.value, r.usualLow, r.usualHigh).dir,
                    tr,
                  )
                }}</span
              >
            </span>
          </component>
        </li>
      </ul>
      <p class="text-12 text-text-subtle">{{ $t('whatChanged.moved.foot') }}</p>
    </section>

    <aside
      class="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-surface-1/45 px-6 py-5 max-md:px-4"
      aria-labelledby="wc-why-title"
      data-testid="wc-why"
    >
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="wc-why-title" class="text-15 font-semibold text-text">
          {{ $t('whatChanged.why.title') }}
        </h3>
        <span class="font-mono text-11 tracking-widest text-text-subtle uppercase">{{
          $t('whatChanged.why.rules')
        }}</span>
      </div>
      <p v-if="!checks.length" class="text-13 text-text-muted" data-testid="wc-no-checks">
        {{ $t('whatChanged.why.noChecks') }}
      </p>
      <ul v-else class="flex flex-col gap-2" data-testid="wc-checks">
        <li
          v-for="(c, i) in checks"
          :key="i"
          class="flex items-start gap-2.5"
          :data-result="c.result"
        >
          <span
            :class="[
              'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-12 font-bold',
              c.result === 'explains' || c.result === 'possible'
                ? 'bg-ok/20 text-ok-text'
                : 'bg-surface-3 text-text-muted',
            ]"
            aria-hidden="true"
            >{{ c.result === 'explains' || c.result === 'possible' ? '!' : '✓' }}</span
          >
          <span class="flex min-w-0 flex-col">
            <span class="text-13 text-text">{{ checkText(c).what }}</span>
            <span class="text-12 text-text-muted">{{ checkText(c).result }}</span>
          </span>
        </li>
      </ul>
      <div class="flex flex-col gap-1.5 border-t border-border pt-3">
        <span class="font-mono text-11 tracking-widest text-text-subtle uppercase">{{
          $t('whatChanged.why.around')
        }}</span>
        <ul v-if="story.changes.length" class="flex flex-col gap-1" data-testid="wc-around">
          <li v-for="(c, i) in story.changes" :key="i" class="flex gap-2 text-13">
            <span class="shrink-0 font-mono text-text-muted">{{ clock(c.at) }}</span>
            <span class="min-w-0 text-text [overflow-wrap:anywhere]">{{
              sentenceStart(changePhrase(changeFactsOf(c), tr))
            }}</span>
          </li>
        </ul>
        <span v-else class="text-13 text-text-muted">{{ $t('whatChanged.why.aroundNone') }}</span>
      </div>
      <div class="flex flex-wrap gap-2 border-t border-border pt-3">
        <button
          type="button"
          class="rounded-control border border-border px-3 py-1.5 text-13 text-text hover:bg-surface-2 max-lg:min-h-11"
          :aria-expanded="evidence"
          data-testid="wc-evidence"
          @click="evidence = !evidence"
        >
          {{ evidence ? $t('whatChanged.why.hideEvidence') : $t('whatChanged.why.evidence') }}
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-control border border-border px-3 py-1.5 text-13 text-text hover:bg-surface-2 max-lg:min-h-11"
          data-testid="wc-copy"
          @click="copyText"
        >
          <component
            :is="copyState === 'copied' ? CheckIcon : Copy"
            class="size-3.5"
            aria-hidden="true"
          />
          {{ copyState === 'copied' ? $t('whatChanged.why.copied') : $t('whatChanged.why.copy') }}
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-control border border-border px-3 py-1.5 text-13 text-text hover:bg-surface-2 max-lg:min-h-11"
          :aria-expanded="ask"
          data-testid="wc-ask"
          @click="ask = !ask"
        >
          <Sparkles class="size-3.5" aria-hidden="true" />
          {{ $t('whatChanged.why.ask') }}
        </button>
      </div>
      <CauseChecks v-if="evidence" :checks="story.checks" open />
      <div v-if="ask" class="flex flex-col gap-1.5">
        <span class="text-13 text-text-muted">{{ $t('whatChanged.why.askHint') }}</span>
        <CodeBlock :code="askText" :label="$t('whatChanged.why.ask')" wrap />
      </div>
    </aside>
  </div>
</template>
