<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { installSnippet } from '@watchlog/snippets';
import { ArrowLeft, ArrowRight, Boxes, Server, X } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router';
import { api } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import { LINKS } from '@/lib/links';
import { since } from '@/lib/time';
import { tourReplays } from '@/lib/tour-signal';
import {
  anotherStories,
  chooseStory,
  type ChosenStory,
  type OpenAlert,
  type TourKind,
  type TourStory,
} from './choose';
import { browserStore, markSeen, tourEntry } from './entry';
import { sendMoment } from './events';

// The live demo's guided tour (1.3.0, ADR-246, the notes' design/guided-demo boards): one
// live incident in four steps on the real pages, from the problem to its cause to the proof
// to "get this on your own systems". Loaded only in demo mode (AppShell's lazy chunk). Live
// data only: the story is an open alert the demo has right now; the only fixed text is the
// cards' own words. No step advances by itself; Skip and Esc everywhere, arrow keys move it.

const { t, te } = useI18n();
const route = useRoute();
const router = useRouter();

type Step = 0 | 1 | 2 | 3 | 4;
const open = ref(false);
const step = ref<Step>(0);
const kind = ref<TourKind | null>(null);
const stories = ref<TourStory[]>([]);
const another = ref<string[]>([]);
const alerts = ref<OpenAlert[]>([]);
const causes = ref(new Map<string, 'likely' | 'possible' | 'none'>());
const titles = ref(new Map<string, string>());
const chosen = ref<ChosenStory | null>(null);
const version = ref<string | null>(null);
const target = ref<DOMRect | null>(null);
const card = ref<HTMLElement | null>(null);
const cardPos = ref<{ top: number; left: number } | null>(null);
const narrow = ref(false);
let returnFocus: HTMLElement | null = null;
let raf = 0;

const eventKind = (k: TourKind) => (k === 'server' ? 'server' : 'kubernetes');

/**
 * What the demo has open now: the alerts its stories could tell (from /demo/tour, so the tour
 * opens no page of its own that the analytics would count), and All clusters' answer for their
 * cause and their titles (the page the visitor lands on).
 */
async function loadLive(): Promise<void> {
  const [tour, all] = await Promise.all([
    api<{ stories: TourStory[]; another: string[]; open: OpenAlert[] }>('/demo/tour'),
    api<{
      problems: {
        title: string;
        causeState?: 'likely' | 'possible' | 'none';
        places: { alertId?: string | null }[];
      }[];
    }>('/overview/all?range=86400').catch(() => ({ problems: [] })),
  ]);
  stories.value = tour.stories;
  another.value = tour.another;
  const c = new Map<string, 'likely' | 'possible' | 'none'>();
  const tt = new Map<string, string>();
  for (const p of all.problems)
    for (const pl of p.places) {
      if (!pl.alertId) continue;
      if (p.causeState) c.set(pl.alertId, p.causeState);
      tt.set(pl.alertId, p.title);
    }
  causes.value = c;
  titles.value = tt;
  alerts.value = tour.open.map((a) => ({ ...a, title: tt.get(a.id) ?? a.rule.name }));
}

const pick = (k: TourKind) => chooseStory(stories.value, k, alerts.value, causes.value);
/** The welcome line's story: the configuration's first side that has one (Kubernetes, drawn). */
const welcomeStory = computed(() => (open.value ? (pick('kubernetes') ?? pick('server')) : null));
const titleOf = (c: ChosenStory) => titles.value.get(c.alert.id) ?? c.alert.title;
const openFor = (c: ChosenStory) => since(c.alert.firedAt ?? c.alert.startedAt);

async function begin(entryKind: TourKind | null, reason: 'link' | 'first' | 'replay') {
  try {
    const health = await fetch('/api/v1/health')
      .then((r) => r.json() as Promise<{ version?: string }>)
      .catch(() => ({}) as { version?: string });
    // A release's version only: a development build has no install command to give.
    version.value = /^\d+\.\d+\.\d+$/.test(health.version ?? '') ? health.version! : null;
    await loadLive();
  } catch {
    return; // the demo's data didn't answer: no tour, the page stays as it is
  }
  if (!pick('kubernetes') && !pick('server')) return;
  markSeen(browserStore());
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  open.value = true;
  if (reason === 'replay') sendMoment({ name: 'replayed' });
  if (entryKind) return start(entryKind);
  step.value = 0;
  sendMoment({ name: 'shown' });
  void prefetchAllClusters();
  await focusCard();
}

/** The side the visitor runs: its story, then step 1. A side with nothing open takes the other. */
async function start(k: TourKind) {
  const c = pick(k) ?? pick(k === 'kubernetes' ? 'server' : 'kubernetes');
  if (!c) return close();
  kind.value = c.story.kind;
  chosen.value = c;
  sendMoment({ name: 'started', kind: eventKind(c.story.kind) });
  await go(1);
}

// ---------------------------------------------------------------- moving between steps

const alertRoute = (c: ChosenStory): RouteLocationRaw => ({
  name: 'alert',
  params: { id: c.alert.id },
  query: { cluster: c.alert.cluster.id },
});

async function go(n: Step) {
  step.value = n;
  target.value = null;
  unmark();
  lit = [];
  if (n >= 1 && n <= 4) sendMoment({ name: 'step', step: n as 1 | 2 | 3 | 4 });
  const c = chosen.value;
  if (n === 1) {
    if (route.name !== 'all-clusters') await router.push({ name: 'all-clusters' });
    if (c) void prefetchAlert(c);
  } else if ((n === 2 || n === 3) && c) {
    if (route.name !== 'alert' || route.params.id !== c.alert.id) await router.push(alertRoute(c));
  } else if (n === 4) {
    // Only the tour's own answer: All clusters' would read as the visitor opening that page.
    void api<{ open: OpenAlert[] }>('/demo/tour')
      .then((t) => {
        alerts.value = t.open.map((a) => ({ ...a, title: titles.value.get(a.id) ?? a.rule.name }));
      })
      .catch(() => {});
  }
  await nextTick();
  if (n >= 1 && n <= 3) await light(n);
  await focusCard();
}

/** The element a step lights, once the page has drawn it (at most 6 s). */
function find(n: Step): HTMLElement[] {
  const c = chosen.value;
  if (n === 1) {
    if (c) {
      const row = [...document.querySelectorAll<HTMLElement>('[data-testid="ac-problem"]')].find(
        (li) => li.querySelector(`a[href*="/alerts/${c.alert.id}"]`),
      );
      if (row) return [row];
    }
    const all = document.querySelector<HTMLElement>('[data-testid="ac-attention"]');
    return all ? [all] : [];
  }
  if (n === 2) {
    const p = document.querySelector<HTMLElement>('[data-testid="cause-panel"]');
    return p ? [p] : [];
  }
  if (n === 3) {
    const chart = document.querySelector<HTMLElement>('[data-testid="alert-chart"]');
    const changed = document.querySelector<HTMLElement>('[data-testid="wc-card"]');
    return [changed, chart].filter((e): e is HTMLElement => !!e);
  }
  return [];
}
let lit: HTMLElement[] = [];
/** The lit elements carry data-tour-lit while lit (for the browser spec and assistive tech). */
function unmark() {
  for (const e of lit) e.removeAttribute('data-tour-lit');
}
async function light(n: Step) {
  const until = Date.now() + 6000;
  let els = find(n);
  while (!els.length && Date.now() < until && open.value && step.value === n) {
    await new Promise((r) => setTimeout(r, 80));
    els = find(n);
  }
  if (step.value !== n) return;
  unmark();
  lit = els;
  for (const e of els) e.setAttribute('data-tour-lit', '');
  // Into view at once, and again once the page has settled (a list above it may still grow).
  const into = () =>
    els[0]?.isConnected && els[0].scrollIntoView({ block: narrow.value ? 'start' : 'center' });
  into();
  setTimeout(() => {
    if (step.value === n && open.value) into();
  }, 400);
  track();
}

/** The lit elements' box and the card beside it, kept in place while the page moves. */
function track() {
  cancelAnimationFrame(raf);
  const tick = () => {
    if (!open.value) return;
    narrow.value = window.innerWidth < 768;
    if (lit.length && step.value >= 1 && step.value <= 3) {
      const rs = lit.filter((e) => e.isConnected).map((e) => e.getBoundingClientRect());
      if (rs.length) {
        const top = Math.min(...rs.map((r) => r.top));
        const left = Math.min(...rs.map((r) => r.left));
        const bottom = Math.max(...rs.map((r) => r.bottom));
        const right = Math.max(...rs.map((r) => r.right));
        target.value = new DOMRect(left, top, right - left, bottom - top);
        place();
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

/** The card under the lit element (the boards), above it when there's no room, else in the corner. */
function place() {
  const r = target.value;
  const el = card.value;
  if (!r || !el || narrow.value) return void (cardPos.value = null);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(16, r.left), vw - w - 16);
  if (r.bottom + 16 + h <= vh - 16) cardPos.value = { top: r.bottom + 16, left };
  else if (r.top - 16 - h >= 16) cardPos.value = { top: r.top - 16 - h, left };
  else cardPos.value = { top: vh - h - 24, left: vw - w - 24 };
}

async function focusCard() {
  await nextTick();
  card.value?.querySelector<HTMLElement>('[data-tour-focus]')?.focus();
}

function close() {
  open.value = false;
  cancelAnimationFrame(raf);
  unmark();
  lit = [];
  target.value = null;
  returnFocus?.focus?.();
}
function skip() {
  sendMoment({ name: 'skipped', step: step.value });
  close();
}
function finish() {
  sendMoment({ name: 'finished' });
  close();
}
function next() {
  if (step.value === 0) return start('kubernetes');
  if (step.value < 4) return go((step.value + 1) as Step);
}
function back() {
  if (step.value > 1) return go((step.value - 1) as Step);
}

// ---------------------------------------------------------------- loading the next page ahead

async function warm(to: RouteLocationRaw) {
  for (const rec of router.resolve(to).matched) {
    const comp = rec.components?.default;
    if (typeof comp === 'function') await (comp as () => Promise<unknown>)().catch(() => {});
  }
}
async function prefetchAllClusters() {
  await warm({ name: 'all-clusters' });
}
async function prefetchAlert(c: ChosenStory) {
  await warm(alertRoute(c));
  // The server keeps a cause 15 s and the alert's answers are quick: asked now, Next is instant.
  void api(`/alerts/${c.alert.id}`).catch(() => {});
  void api(
    `/causes?cluster=${c.alert.cluster.id}&subject=${encodeURIComponent(`alert:${c.alert.id}`)}`,
  ).catch(() => {});
}

// ---------------------------------------------------------------- the end card

const utm = 'utm_source=demo_tour&utm_medium=demo&utm_campaign=guided_tour';
const cloudHref = `${LINKS.cloudSignup}?${utm}`;
const installHref = computed(
  () => `${LINKS.install}?${utm}#${kind.value === 'server' ? 'with-docker-compose' : 'kubernetes'}`,
);
const command = computed(() =>
  version.value ? installSnippet(kind.value ?? 'kubernetes', version.value) : null,
);
const others = computed(() =>
  step.value === 4
    ? anotherStories(
        stories.value,
        another.value,
        chosen.value?.story.id ?? null,
        alerts.value,
        causes.value,
      ).filter((o) => te(`tour.stories.${o.story.id}.title`))
    : [],
);
async function seeAnother(o: ChosenStory) {
  sendMoment({ name: 'another', story: o.story.id });
  chosen.value = o;
  kind.value = o.story.kind;
  await go(1);
}

// ---------------------------------------------------------------- the words

const storyKey = (part: 'why' | 'proof') => {
  const id = chosen.value?.story.id;
  return id && te(`tour.stories.${id}.${part}`)
    ? `tour.stories.${id}.${part}`
    : `tour.${part}.${kind.value === 'server' ? 'server' : 'kubernetes'}`;
};
const STEP_WORDS = {
  1: { title: 'tour.problem.title', next: 'tour.problem.next' },
  2: { title: 'tour.why.title', next: 'tour.why.next' },
  3: { title: 'tour.proof.title', next: 'tour.proof.next' },
} as const;
const body = computed(() =>
  step.value === 1
    ? t('tour.problem.body')
    : step.value === 2
      ? t(storyKey('why'))
      : step.value === 3
        ? t(storyKey('proof'))
        : '',
);

// ---------------------------------------------------------------- keys, focus, entry

function onKey(e: KeyboardEvent) {
  if (!open.value) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    return skip();
  }
  const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, select');
  if (typing) return;
  if (e.key === 'ArrowRight' && step.value >= 1 && step.value < 4) {
    e.preventDefault();
    void next();
  } else if (e.key === 'ArrowLeft' && step.value > 1) {
    e.preventDefault();
    void back();
  } else if (e.key === 'Tab' && card.value) {
    // Focus stays in the card while the tour is open.
    const f = [
      ...card.value.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex="0"]',
      ),
    ];
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  narrow.value = window.innerWidth < 768;
  await router.isReady();
  const entry = tourEntry(route.query.tour, browserStore());
  if (entry.open) await begin(entry.kind, entry.reason);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  cancelAnimationFrame(raf);
});
watch(tourReplays, () => {
  if (!open.value) void begin(null, 'replay');
});

const spotlight = computed(() => {
  const r = target.value;
  if (!r) return null;
  const pad = 8;
  return {
    top: `${r.top - pad}px`,
    left: `${r.left - pad}px`,
    width: `${r.width + pad * 2}px`,
    height: `${r.height + pad * 2}px`,
  };
});
</script>

<template>
  <div v-if="open" class="tour" data-testid="tour" :data-step="step" :data-kind="kind ?? ''">
    <!-- The page under the tour: dimmed, and not clickable while a card is open. -->
    <div
      class="fixed inset-0 z-[60]"
      :class="step === 0 || step === 4 || !spotlight ? 'bg-bg/75' : ''"
      aria-hidden="true"
      data-testid="tour-scrim"
    />
    <div
      v-if="spotlight && step >= 1 && step <= 3"
      class="tour-spot pointer-events-none fixed z-[61] rounded-card ring-2 ring-primary motion-safe:transition-all motion-safe:duration-200"
      :style="spotlight"
      aria-hidden="true"
      data-testid="tour-spotlight"
    />

    <!-- 0 · Welcome, 4 · The end: one centred card (a sheet at the bottom on a phone). -->
    <div
      v-if="step === 0 || step === 4"
      class="fixed inset-0 z-[62] flex items-center justify-center p-4 max-md:items-end max-md:p-0"
    >
      <section
        ref="card"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="step === 0 ? 'tour-welcome-title' : 'tour-end-title'"
        class="flex max-h-[calc(100dvh-2rem)] w-full max-w-[560px] flex-col gap-5 overflow-y-auto *:shrink-0 rounded-card border border-border bg-surface-1 p-7 shadow-lg max-md:max-h-[85dvh] max-md:max-w-none max-md:rounded-b-none max-md:p-5"
        :data-testid="step === 0 ? 'tour-welcome' : 'tour-end'"
      >
        <template v-if="step === 0">
          <div class="flex items-center justify-between gap-3">
            <span class="inline-flex items-center gap-2 text-13 font-semibold text-text">
              <span class="size-2 rounded-full bg-primary" aria-hidden="true" />{{
                $t('tour.welcome.label')
              }}
            </span>
            <span class="text-12 text-text-muted max-md:hidden">{{ $t('tour.welcome.esc') }}</span>
          </div>
          <div class="flex flex-col gap-2">
            <h2
              id="tour-welcome-title"
              tabindex="-1"
              data-tour-focus
              class="text-24 font-semibold text-text outline-none max-md:text-20"
            >
              {{ $t('tour.welcome.title') }}
            </h2>
            <p class="text-16 text-text-muted">{{ $t('tour.welcome.body') }}</p>
          </div>
          <p
            v-if="welcomeStory"
            class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-control border border-border bg-surface-2 px-3 py-2 text-13"
            data-testid="tour-live"
          >
            <span class="size-2 shrink-0 rounded-full bg-critical" aria-hidden="true" />
            <span class="font-semibold break-words text-text">{{ titleOf(welcomeStory) }}</span>
            <span class="text-text-muted">{{
              $t('tour.welcome.open', { d: openFor(welcomeStory) })
            }}</span>
          </p>
          <div class="flex flex-col gap-3">
            <h3 class="text-14 font-semibold text-text">{{ $t('tour.welcome.question') }}</h3>
            <div class="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <button
                v-for="k in ['kubernetes', 'server'] as const"
                :key="k"
                type="button"
                class="flex flex-col items-start gap-1.5 rounded-card border border-border bg-surface-2 p-4 text-left hover:border-primary-border focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
                :disabled="!pick(k)"
                :data-testid="`tour-kind-${k}`"
                @click="start(k)"
              >
                <span class="inline-flex items-center gap-2 text-16 font-semibold text-text">
                  <component
                    :is="k === 'server' ? Server : Boxes"
                    class="size-4"
                    aria-hidden="true"
                  />
                  {{ $t(`tour.welcome.${k}.title`) }}
                </span>
                <span class="text-13 text-text-muted">{{ $t(`tour.welcome.${k}.body`) }}</span>
              </button>
            </div>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              class="text-13 font-semibold text-link hover:underline max-lg:min-h-11"
              data-testid="tour-own"
              @click="skip"
            >
              {{ $t('tour.welcome.own') }}
            </button>
            <span class="text-12 text-text-muted">{{ $t('tour.welcome.foot') }}</span>
          </div>
        </template>

        <template v-else>
          <div class="flex items-center justify-between gap-3">
            <span class="text-12 font-semibold tracking-wider text-text-muted uppercase">{{
              $t('tour.step', { n: 4 })
            }}</span>
            <button
              type="button"
              class="inline-flex size-8 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text max-lg:size-11"
              :aria-label="$t('tour.close')"
              data-testid="tour-close"
              @click="finish"
            >
              <X class="size-4" aria-hidden="true" />
            </button>
          </div>
          <div class="flex flex-col gap-2">
            <h2
              id="tour-end-title"
              tabindex="-1"
              data-tour-focus
              class="text-24 font-semibold text-text outline-none max-md:text-20"
            >
              {{ $t('tour.end.title') }}
            </h2>
            <p class="text-16 text-text-muted">{{ $t('tour.end.body') }}</p>
          </div>
          <CodeBlock
            v-if="command"
            :code="command"
            :label="$t(`tour.end.command.${kind === 'server' ? 'server' : 'kubernetes'}`)"
            wrap
            data-testid="tour-command"
          />
          <ul class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-13 text-text max-sm:grid-cols-1">
            <li v-for="i in 6" :key="i" class="flex items-center gap-2">
              <span class="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />{{
                $t(`tour.end.points.${i}`)
              }}
            </li>
          </ul>
          <div class="flex flex-wrap gap-3">
            <a
              :href="cloudHref"
              target="_blank"
              rel="noopener"
              class="inline-flex h-11 items-center justify-center gap-2 rounded-control bg-primary px-5 text-14 font-semibold text-on-primary hover:bg-primary-hover max-sm:w-full"
              data-testid="tour-cloud"
              @click="sendMoment({ name: 'cloud' })"
              >{{ $t('tour.end.cloud') }}<ArrowRight class="size-4" aria-hidden="true"
            /></a>
            <a
              :href="installHref"
              target="_blank"
              rel="noopener"
              class="inline-flex h-11 items-center justify-center gap-2 rounded-control border border-border-strong px-5 text-14 font-semibold text-text hover:bg-surface-2 max-sm:w-full"
              data-testid="tour-install"
              @click="sendMoment({ name: 'install' })"
              >{{ $t('tour.end.install') }}</a
            >
          </div>
          <div v-if="others.length" class="flex flex-col gap-2.5" data-testid="tour-another">
            <h3 class="text-14 font-semibold text-text">{{ $t('tour.end.another') }}</h3>
            <div class="grid gap-2.5" :class="others.length > 1 ? 'sm:grid-cols-2' : ''">
              <button
                v-for="o in others"
                :key="o.story.id"
                type="button"
                class="flex flex-col items-start gap-1 rounded-card border border-border bg-surface-2 p-3 text-left hover:border-primary-border focus-visible:outline-2 focus-visible:outline-primary max-lg:min-h-11"
                :data-testid="`tour-another-${o.story.id}`"
                @click="seeAnother(o)"
              >
                <span class="text-13 font-semibold text-text">{{
                  $t(`tour.stories.${o.story.id}.title`)
                }}</span>
                <span class="text-12 text-text-muted">{{ titleOf(o) }}</span>
              </button>
            </div>
          </div>
          <button
            type="button"
            class="self-start text-13 font-semibold text-link hover:underline max-lg:min-h-11"
            data-testid="tour-keep"
            @click="finish"
          >
            {{ $t('tour.end.keep') }}
          </button>
        </template>
      </section>
    </div>

    <!-- 1 to 3 · the coach card under the lit element (a sheet at the bottom on a phone). -->
    <section
      v-else
      ref="card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-card-title"
      class="fixed z-[62] flex flex-col gap-3 *:shrink-0 rounded-card border border-border bg-surface-1 p-5 shadow-lg md:w-[420px] max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[55dvh] max-md:overflow-y-auto max-md:rounded-b-none"
      :class="cardPos ? '' : 'md:right-6 md:bottom-6'"
      :style="cardPos ? { top: `${cardPos.top}px`, left: `${cardPos.left}px` } : undefined"
      data-testid="tour-card"
    >
      <div class="flex items-center justify-between gap-3">
        <span class="text-12 font-semibold tracking-wider text-text-muted uppercase">{{
          $t('tour.step', { n: step })
        }}</span>
        <button
          type="button"
          class="inline-flex size-8 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text max-lg:size-11"
          :aria-label="$t('tour.skip')"
          data-testid="tour-x"
          @click="skip"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </div>
      <h2
        id="tour-card-title"
        tabindex="-1"
        data-tour-focus
        class="text-20 font-semibold text-text outline-none"
      >
        {{ $t(STEP_WORDS[step as 1 | 2 | 3].title) }}
      </h2>
      <p class="text-14 text-text-muted" data-testid="tour-body">{{ body }}</p>
      <p v-if="step === 2" class="text-12 text-text-subtle">{{ $t('tour.why.small') }}</p>
      <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
        <button
          v-if="step === 1"
          type="button"
          class="text-13 font-semibold text-text-muted hover:text-text max-lg:min-h-11"
          data-testid="tour-skip"
          @click="skip"
        >
          {{ $t('tour.skip') }}
        </button>
        <BaseButton v-else variant="ghost" data-testid="tour-back" @click="back">
          <ArrowLeft class="size-4" aria-hidden="true" />{{ $t('tour.back') }}
        </BaseButton>
        <BaseButton data-testid="tour-next" @click="next">
          {{ $t(STEP_WORDS[step as 1 | 2 | 3].next)
          }}<ArrowRight class="size-4" aria-hidden="true" />
        </BaseButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* The page around the lit element dims; the colour is the page's own (a token). */
.tour-spot {
  box-shadow: 0 0 0 200vmax color-mix(in srgb, var(--bg) 72%, transparent);
}
</style>
