<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import {
  Box,
  Boxes,
  Clock,
  Container,
  CornerDownLeft,
  FileText,
  Layers,
  Search,
  Server,
  X,
} from '@lucide/vue';
import type { SearchResponse, SearchResult } from '@watchlog/api-types';
import { storeToRefs } from 'pinia';
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxRoot,
  ComboboxViewport,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import { KIND_LOGO } from '@/components/ui/kindLogos';
import { ServiceLogo } from '@/components/ui/serviceLogos';
import { useNarrow } from '@/composables/useNarrow';
import { serviceName } from '@/lib/applications';
import {
  addRecent,
  groupItems,
  loadRecent,
  opensPalette,
  PLATFORM,
  rankItems,
  rankOfTier,
  resultLink,
  saveRecent,
  type PaletteGroup,
  type PaletteItem,
  type RecentItem,
} from '@/lib/palette';
import { navFor, NAV_ITEMS, type ClusterKind } from '@/router';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { useUiStore } from '@/stores/ui';

// The ⌘K command palette (ADR-169, SPEC §11.3): ⌘K / Ctrl+K, `/` outside a field, or the top
// bar's button. Pages and clusters are matched here; the selected cluster's objects come
// from GET /clusters/:id/search, 150 ms after the last key. A modal dialog with Reka UI's
// combobox and grouped listbox; full screen on phones. Read-only navigation.
const DEBOUNCE_MS = 150;

const { t } = useI18n();
const router = useRouter();
const ui = useUiStore();
const { paletteOpen: open } = storeToRefs(ui);
const clusters = useClustersStore();
const auth = useAuthStore();
const narrow = useNarrow();

const query = ref('');
const results = ref<SearchResult[]>([]);
const resultsFor = ref('');
const loading = ref(false);
const failed = ref(false);
const recent = ref<RecentItem[]>([]);
const userId = computed(() => (auth.user as { id?: string } | null)?.id ?? '');
const cluster = computed(() => clusters.selected);

// ---- What is listed ----------------------------------------------------------------------

const pages = computed<Omit<PaletteItem, 'rank'>[]>(() =>
  navFor(cluster.value?.kind as ClusterKind | undefined).map((p) => ({
    key: `page:${p.name}`,
    kind: 'page',
    label: t(p.titleKey),
    detail: t('palette.detail.page'),
    to: { name: p.name, query: cluster.value ? { cluster: cluster.value.id } : {} },
    page: p.name,
  })),
);
const clusterItems = computed<Omit<PaletteItem, 'rank'>[]>(() =>
  clusters.list.map((c) => ({
    key: `cluster:${c.id}`,
    kind: 'cluster',
    label: c.name,
    detail:
      c.id === cluster.value?.id
        ? t('palette.detail.currentCluster', { kind: t(`clusters.kind.${c.kind}`) })
        : t(`clusters.kind.${c.kind}`),
    to: { name: 'overview', query: { cluster: c.id } },
    clusterId: c.id,
    logo: c.kind,
  })),
);

function detailOf(r: SearchResult): string {
  switch (r.kind) {
    case 'workload':
      return t('palette.detail.workload', { type: r.type ?? '', namespace: r.namespace ?? '' });
    case 'pod':
      return t('palette.detail.pod', { namespace: r.namespace ?? '' });
    case 'node':
      return t('palette.detail.node');
    case 'host':
      return t('palette.detail.host');
    case 'container':
      return r.namespace
        ? t('palette.detail.containerInProject', { project: r.namespace, host: r.host ?? '' })
        : t('palette.detail.container', { host: r.host ?? '' });
    case 'compose_project':
      return t('palette.detail.composeProject', { host: r.host ?? '' });
    case 'application':
      return [serviceName(r.type ?? ''), r.namespace ?? r.host].filter(Boolean).join(' · ');
  }
}

const remoteItems = computed<PaletteItem[]>(() => {
  const id = cluster.value?.id;
  if (!id) return [];
  return results.value.map((r) => ({
    key: `${r.kind}:${r.id ?? `${r.host ?? ''}/${r.namespace ?? ''}/${r.name}`}`,
    kind: r.kind,
    label: r.name,
    detail: detailOf(r),
    to: resultLink(r, id),
    rank: rankOfTier(r.match),
    logo: r.kind === 'application' ? (r.type ?? undefined) : undefined,
  }));
});

const trimmed = computed(() => query.value.trim());

/** The listed groups; each option's value is `<group>|<key>` (a recent pick can repeat a page). */
const groups = computed<(PaletteGroup & { id: string })[]>(() => {
  if (!trimmed.value) {
    const out: (PaletteGroup & { id: string })[] = [];
    if (recent.value.length)
      out.push({
        id: 'recent',
        kind: 'page',
        items: recent.value.map((r) => ({ ...r, rank: 0 })),
      });
    out.push({ id: 'page', kind: 'page', items: pages.value.map((p) => ({ ...p, rank: 0 })) });
    if (clusterItems.value.length > 1)
      out.push({
        id: 'cluster',
        kind: 'cluster',
        items: clusterItems.value.map((c) => ({ ...c, rank: 0 })),
      });
    return out;
  }
  const local = [
    ...rankItems(pages.value, trimmed.value),
    ...rankItems(clusterItems.value, trimmed.value),
  ];
  // Results of an older query stay until the new ones arrive, unless nothing matched.
  return groupItems([...local, ...remoteItems.value]).map((g) => ({ ...g, id: g.kind }));
});

const count = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0));
const byValue = computed(
  () =>
    new Map<string, PaletteItem>(
      groups.value.flatMap((g) =>
        g.items.map((i): [string, PaletteItem] => [`${g.id}|${i.key}`, i]),
      ),
    ),
);

/** What the live region says: the number of results, once they are in. */
const announcement = computed(() => {
  if (!open.value) return '';
  if (!trimmed.value)
    return t('palette.recentCount', { n: recent.value.length }, recent.value.length);
  if (loading.value || resultsFor.value !== trimmed.value) return '';
  if (failed.value) return t('palette.failed');
  return t('palette.count', { n: count.value }, count.value);
});

// ---- The search --------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;

async function search(q: string) {
  const id = cluster.value?.id;
  const mine = ++seq;
  if (!id) {
    results.value = [];
    resultsFor.value = q;
    loading.value = false;
    return;
  }
  try {
    const res = await api<SearchResponse>(
      `/clusters/${id}/search?q=${encodeURIComponent(q)}&limit=40`,
    );
    if (mine !== seq) return; // A newer query is on its way.
    results.value = res.results;
    failed.value = false;
  } catch {
    if (mine !== seq) return;
    results.value = [];
    failed.value = true;
  }
  resultsFor.value = q;
  loading.value = false;
}

watch(trimmed, (q) => {
  clearTimeout(timer);
  if (!q) {
    seq++;
    results.value = [];
    resultsFor.value = '';
    loading.value = false;
    failed.value = false;
    return;
  }
  loading.value = true;
  timer = setTimeout(() => void search(q), DEBOUNCE_MS);
});

// The first option is highlighted whenever the list changes, so Enter opens the best match.
const root = ref<{ highlightFirstItem?: () => void } | null>(null);
watch(groups, () => void nextTick(() => root.value?.highlightFirstItem?.()), { flush: 'post' });

// Each opening starts empty. (Reset on open, not on close: the combobox may report that it
// closed before the pick it closes for.)
watch(open, (o) => {
  clearTimeout(timer);
  seq++;
  if (!o) return;
  query.value = '';
  results.value = [];
  resultsFor.value = '';
  loading.value = false;
  failed.value = false;
  recent.value = userId.value ? loadRecent(userId.value) : [];
  void nextTick(() => root.value?.highlightFirstItem?.());
});

// ---- Picking -----------------------------------------------------------------------------

function pick(value: unknown) {
  const item = typeof value === 'string' ? byValue.value.get(value) : undefined;
  if (!item) return;
  if (userId.value) {
    recent.value = addRecent(recent.value, item);
    saveRecent(userId.value, recent.value);
  }
  if (item.clusterId) clusters.select(item.clusterId);
  open.value = false;
  void router.push(item.to);
}

// Escape reaches the combobox's own layer first; when it closes, so does the dialog.
function onComboboxOpen(o: boolean) {
  if (!o) open.value = false;
}

// ---- Shortcuts ---------------------------------------------------------------------------

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || !auth.user) return;
  if (!opensPalette(e)) return;
  e.preventDefault();
  open.value = e.key === '/' ? true : !open.value;
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  clearTimeout(timer);
});

// ---- Looks -------------------------------------------------------------------------------

const KIND_ICON: Record<string, Component> = {
  workload: Boxes,
  pod: Box,
  node: Server,
  host: Server,
  container: Container,
  compose_project: Layers,
};
const pageIcon = (name?: string) => NAV_ITEMS.find((p) => p.name === name)?.icon ?? FileText;
function iconOf(i: PaletteItem): Component {
  if (i.kind === 'page') return pageIcon(i.page);
  if (i.kind === 'cluster') return KIND_LOGO[(i.logo as ClusterKind) ?? 'kubernetes'];
  return KIND_ICON[i.kind] ?? FileText;
}
const groupLogo = (g: PaletteGroup & { id: string }) =>
  g.id === 'recent' ? null : (PLATFORM[g.kind] ?? null);
const groupTitle = (g: PaletteGroup & { id: string }) =>
  t(g.id === 'recent' ? 'palette.groups.recent' : `palette.groups.${g.kind}`);
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-bg/70" />
      <DialogContent
        data-testid="palette"
        :class="[
          'fixed z-50 flex flex-col overflow-hidden bg-surface-1 shadow-xl',
          narrow
            ? 'inset-0 h-dvh'
            : 'top-[12vh] left-1/2 max-h-[min(36rem,76dvh)] w-[calc(100%-2rem)] max-w-160 -translate-x-1/2 rounded-card border border-border',
        ]"
      >
        <DialogTitle class="sr-only">{{ $t('palette.title') }}</DialogTitle>
        <DialogDescription class="sr-only">{{ $t('palette.description') }}</DialogDescription>
        <ComboboxRoot
          ref="root"
          :open="true"
          :model-value="null"
          ignore-filter
          :reset-search-term-on-blur="false"
          :reset-search-term-on-select="false"
          class="flex min-h-0 flex-1 flex-col"
          @update:model-value="pick"
          @update:open="onComboboxOpen"
        >
          <ComboboxAnchor
            :class="[
              'flex shrink-0 items-center gap-2 border-b border-border pl-4',
              narrow ? 'h-14 pr-1' : 'h-13 pr-3',
            ]"
          >
            <Search class="size-4.5 shrink-0 text-text-subtle" aria-hidden="true" />
            <ComboboxInput
              v-model="query"
              data-testid="palette-input"
              :aria-label="$t('palette.label')"
              :placeholder="
                cluster
                  ? $t('palette.placeholder', { cluster: cluster.name })
                  : $t('palette.placeholderNone')
              "
              :display-value="() => query"
              autocomplete="off"
              spellcheck="false"
              class="h-full min-w-0 flex-1 bg-transparent text-16 text-text outline-none placeholder:text-text-subtle"
            />
            <span
              v-if="loading && trimmed"
              class="size-3.5 shrink-0 animate-spin rounded-full border-2 border-border-strong border-t-primary motion-reduce:animate-none"
              aria-hidden="true"
              data-testid="palette-loading"
            />
            <button
              v-if="narrow"
              type="button"
              class="flex size-11 shrink-0 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text"
              :aria-label="$t('common.close')"
              data-testid="palette-close"
              @click="open = false"
            >
              <X class="size-5" aria-hidden="true" />
            </button>
            <kbd
              v-else
              class="shrink-0 rounded-[4px] border border-border px-1.5 py-0.5 font-mono text-12 text-text-subtle"
              >Esc</kbd
            >
          </ComboboxAnchor>

          <ComboboxContent position="inline" class="flex min-h-0 flex-1 flex-col">
            <ComboboxViewport
              class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
              data-testid="palette-list"
            >
              <ComboboxGroup
                v-for="g in groups"
                :key="g.id"
                class="pb-1"
                :data-testid="`palette-group-${g.id}`"
              >
                <ComboboxLabel
                  class="flex items-center gap-1.5 px-2 pt-2 pb-1 text-12 font-medium text-text-subtle"
                >
                  <Clock v-if="g.id === 'recent'" class="size-3.5" aria-hidden="true" />
                  <component
                    :is="KIND_LOGO[groupLogo(g)!]"
                    v-else-if="groupLogo(g)"
                    class="size-3.5"
                  />
                  {{ groupTitle(g) }}
                </ComboboxLabel>
                <ComboboxItem
                  v-for="i in g.items"
                  :key="`${g.id}|${i.key}`"
                  :value="`${g.id}|${i.key}`"
                  :text-value="i.label"
                  data-testid="palette-option"
                  :class="[
                    'group/option flex w-full cursor-pointer items-center gap-3 rounded-control px-2 text-text outline-none data-[highlighted]:bg-surface-3',
                    narrow ? 'min-h-12 py-1.5' : 'min-h-10 py-1.5 max-lg:min-h-11',
                  ]"
                >
                  <span
                    class="flex size-7 shrink-0 items-center justify-center rounded-control border border-border bg-surface-2 text-text-muted"
                  >
                    <ServiceLogo
                      v-if="i.kind === 'application' && i.logo"
                      :type="i.logo"
                      class="size-4"
                    />
                    <component :is="iconOf(i)" v-else class="size-4" aria-hidden="true" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-14 text-text">{{ i.label }}</span>
                    <span class="block truncate text-12 text-text-muted">{{ i.detail }}</span>
                  </span>
                  <CornerDownLeft
                    v-if="!narrow"
                    class="size-3.5 shrink-0 text-text-subtle opacity-0 group-data-[highlighted]/option:opacity-100"
                    aria-hidden="true"
                  />
                </ComboboxItem>
              </ComboboxGroup>
              <p
                v-if="trimmed && count === 0"
                class="px-2 py-6 text-center text-14 text-text-muted"
                data-testid="palette-empty"
              >
                {{
                  loading
                    ? $t('palette.searching')
                    : failed
                      ? $t('palette.failed')
                      : $t('palette.noMatches', { query: trimmed })
                }}
              </p>
            </ComboboxViewport>
          </ComboboxContent>
        </ComboboxRoot>

        <footer
          v-if="!narrow"
          class="flex shrink-0 items-center gap-4 border-t border-border px-4 py-2 text-12 text-text-subtle"
          aria-hidden="true"
        >
          <span
            ><kbd class="font-mono">↑</kbd> <kbd class="font-mono">↓</kbd>
            {{ $t('palette.keys.move') }}</span
          >
          <span><kbd class="font-mono">↵</kbd> {{ $t('palette.keys.open') }}</span>
          <span><kbd class="font-mono">Esc</kbd> {{ $t('palette.keys.close') }}</span>
        </footer>
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          class="sr-only"
          data-testid="palette-status"
        >
          {{ announcement }}
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
