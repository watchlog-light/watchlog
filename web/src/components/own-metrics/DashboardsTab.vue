<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Dashboards of own metrics (1.0.0, ADR-237): the org's, switched with chips. Reading: the
// widgets on a 12-column grid (one column on a phone), one time range, read again every 30 s
// while visible. Editing (Owners and Admins): a side panel makes or changes a widget with a
// live preview; widgets are dragged by their handle or moved with buttons and keys, resized by
// their corner or with buttons and keys; "Done" saves all of it at once, and leaving with
// changes asks first.
import type { OwnDashboard, OwnMetric, OwnWidget } from '@watchlog/api-types';
import { ArrowLeft, ArrowRight, GripVertical, Minus, Pencil, Plus, Trash2 } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
  type RouteLocationNormalized,
} from 'vue-router';
import { ApiError } from '@/api/client';
import { ownDashboardsApi } from '@/api/own-metrics';
import DashboardWidget from '@/components/own-metrics/DashboardWidget.vue';
import WidgetEditor from '@/components/own-metrics/WidgetEditor.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import TextField from '@/components/ui/TextField.vue';
import { useLoader } from '@/composables/useLoader';
import { useNarrow } from '@/composables/useNarrow';
import { usePolling } from '@/composables/usePolling';
import { changed, moveBy, moveOnto, snapWidth, stepWidth, toInput } from '@/lib/own-dashboard';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';

defineProps<{ cluster: { id: string; name: string }; metrics: OwnMetric[] }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toast = useToastStore();
const narrow = useNarrow('(max-width: 1023px)');

// ------------------------------------------------------------------------- the list
const list = useLoader(() => ownDashboardsApi.list());
const dashboards = computed(() => list.data.value?.dashboards ?? []);
const limits = computed(() => list.data.value?.limits ?? { dashboards: 0, widgetsPerDashboard: 0 });
const selectedId = computed<string | null>(() => {
  const q = typeof route.query.dashboard === 'string' ? route.query.dashboard : null;
  if (q && dashboards.value.some((d) => d.id === q)) return q;
  return dashboards.value[0]?.id ?? null;
});
const select = (id: string | null) =>
  router.replace({ query: { ...route.query, dashboard: id ?? undefined } });

// ------------------------------------------------------------------------- the dashboard
const board = useLoader<OwnDashboard | null>(() =>
  selectedId.value ? ownDashboardsApi.get(selectedId.value) : Promise.resolve(null),
);
const tick = ref(0);
watch(selectedId, () => void board.load());
onMounted(async () => {
  await list.load();
  await board.load();
});
// Every 30 s while the tab is visible: the numbers here, each widget's line by `tick`.
const poll = usePolling(async () => {
  if (editing.value) return;
  await board.load();
  tick.value++;
}, 30_000);
poll.start();

// ------------------------------------------------------------------------- editing
const editing = ref(false);
const draft = ref<OwnWidget[]>([]);
const saving = ref(false);
/** The widget in the side panel: its id, 'new', or null when the panel is closed. */
const panel = ref<string | null>(null);
const saved = computed(() => board.data.value?.widgets ?? []);
const widgets = computed(() => (editing.value ? draft.value : saved.value));
const dirty = computed(() => editing.value && changed(saved.value, draft.value));
const full = computed(() => draft.value.length >= limits.value.widgetsPerDashboard);

function edit(open: string | null = null) {
  draft.value = saved.value.map((w) => ({ ...w }));
  editing.value = true;
  panel.value = open;
}
function stop() {
  editing.value = false;
  panel.value = null;
  draft.value = [];
}
const words = (err: unknown) =>
  (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.dashboards.failed');
async function done() {
  if (!board.data.value) return;
  if (!dirty.value) return stop();
  saving.value = true;
  try {
    board.data.value = await ownDashboardsApi.save(board.data.value.id, {
      widgets: draft.value.map(toInput),
    });
    stop();
    tick.value++;
    void list.load();
  } catch (err) {
    toast.show(words(err), 'warning');
  } finally {
    saving.value = false;
  }
}

function apply(w: OwnWidget) {
  const i = draft.value.findIndex((x) => x.id === w.id);
  draft.value = i < 0 ? [...draft.value, w] : draft.value.map((x) => (x.id === w.id ? w : x));
  panel.value = null;
}
const remove = (id: string) => {
  draft.value = draft.value.filter((w) => w.id !== id);
  if (panel.value === id) panel.value = null;
};
const move = (id: string, by: -1 | 1) => (draft.value = moveBy(draft.value, id, by));
const resize = (id: string, by: -1 | 1) =>
  (draft.value = draft.value.map((w) => (w.id === id ? { ...w, w: stepWidth(w.w, by) } : w)));
const panelWidget = computed(() =>
  panel.value && panel.value !== 'new'
    ? (draft.value.find((w) => w.id === panel.value) ?? null)
    : null,
);

// Dragging a widget by its handle: it takes the place of the widget under the pointer.
const grid = ref<HTMLElement>();
const dragging = ref<string | null>(null);
let lastSwap = 0;
function dragStart(e: PointerEvent, id: string) {
  dragging.value = id;
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
}
function dragMove(e: PointerEvent) {
  const id = dragging.value;
  if (!id || Date.now() - lastSwap < 150) return;
  const over = document
    .elementsFromPoint(e.clientX, e.clientY)
    .map((el) => (el as HTMLElement).closest?.<HTMLElement>('[data-widget-id]'))
    .find((el) => el && el.dataset.widgetId !== id);
  const onto = over?.dataset.widgetId;
  if (!onto) return;
  draft.value = moveOnto(draft.value, id, onto);
  lastSwap = Date.now();
}
const dragEnd = () => (dragging.value = null);

// Resizing by the corner: the width nearest to where the corner is, of the grid's 12 columns.
const resizing = ref<string | null>(null);
function sizeStart(e: PointerEvent, id: string) {
  resizing.value = id;
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
}
function sizeMove(e: PointerEvent) {
  const id = resizing.value;
  const g = grid.value?.getBoundingClientRect();
  const el = grid.value?.querySelector<HTMLElement>(`[data-widget-id="${id}"]`);
  if (!id || !g || !el || g.width === 0) return;
  const w = snapWidth((e.clientX - el.getBoundingClientRect().left) / g.width);
  draft.value = draft.value.map((x) => (x.id === id && x.w !== w ? { ...x, w } : x));
}
const sizeEnd = () => (resizing.value = null);

function handleKey(e: KeyboardEvent, id: string, what: 'move' | 'size') {
  const by =
    e.key === 'ArrowLeft' || e.key === 'ArrowUp'
      ? -1
      : e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : 0;
  if (!by) return;
  e.preventDefault();
  if (what === 'move') move(id, by);
  else resize(id, by);
}

// ------------------------------------------------------------------------- leaving with changes
const leaving = ref<(() => void) | null>(null);
const askLeave = computed({
  get: () => leaving.value !== null,
  set: (v) => {
    if (!v) leaving.value = null;
  },
});
/** Runs `go` now, or after "Discard changes" when there are unsaved ones. */
function guarded(go: () => void) {
  if (!dirty.value) {
    if (editing.value) stop();
    return go();
  }
  leaving.value = () => {
    stop();
    go();
  };
}
function onRoute(to: RouteLocationNormalized, from: RouteLocationNormalized) {
  if (!dirty.value) return true;
  const same =
    to.name === from.name &&
    to.query.tab === from.query.tab &&
    to.query.cluster === from.query.cluster &&
    to.query.dashboard === from.query.dashboard;
  if (same) return true;
  leaving.value = () => {
    stop();
    void router.push(to.fullPath);
  };
  return false;
}
onBeforeRouteLeave(onRoute);
onBeforeRouteUpdate(onRoute);
const beforeUnload = (e: BeforeUnloadEvent) => {
  if (dirty.value) e.preventDefault();
};
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
function discard() {
  const go = leaving.value;
  leaving.value = null;
  go?.();
}

// ------------------------------------------------------------------------- new, rename, copy, delete
const naming = ref<'new' | 'rename' | 'copy' | null>(null);
const name = ref('');
const nameError = ref('');
const nameOpen = computed({
  get: () => naming.value !== null,
  set: (v) => {
    if (!v) naming.value = null;
  },
});
function ask(what: 'new' | 'rename' | 'copy') {
  const current = board.data.value?.name ?? '';
  name.value =
    what === 'rename'
      ? current
      : what === 'copy'
        ? t('ownMetrics.dashboards.copyName', { name: current })
        : '';
  nameError.value = '';
  naming.value = what;
}
async function submitName() {
  const what = naming.value;
  const value = name.value.trim();
  if (!what) return;
  if (!value) {
    nameError.value = t('ownMetrics.dashboards.nameNeeded');
    return;
  }
  saving.value = true;
  try {
    if (what === 'rename') {
      const res = await ownDashboardsApi.save(board.data.value!.id, { name: value });
      if (board.data.value) board.data.value = { ...board.data.value, name: res.name };
      await list.load();
    } else {
      const made = await ownDashboardsApi.create(
        value,
        what === 'copy' ? board.data.value?.id : undefined,
      );
      await list.load();
      await select(made.id);
      await board.load();
      // A new dashboard starts in edit mode with the panel open: there is nothing to read yet.
      if (what === 'new') edit('new');
    }
    naming.value = null;
  } catch (err) {
    nameError.value = words(err);
  } finally {
    saving.value = false;
  }
}
const deleting = ref(false);
async function removeBoard() {
  const id = board.data.value!.id;
  await ownDashboardsApi.remove(id);
  stop();
  await list.load();
  await select(null);
  await board.load();
}
const atLimit = computed(() => dashboards.value.length >= limits.value.dashboards);

defineExpose({ reload: () => void board.load() });
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="own-dashboards">
    <ErrorState
      v-if="list.error.value && !list.loaded.value"
      :message="$t('ownMetrics.dashboards.error')"
      :retrying="list.loading.value"
      @retry="list.load"
    />
    <template v-else-if="list.loaded.value">
      <!-- The switcher: one chip per dashboard, then "New dashboard". -->
      <div class="flex flex-wrap items-center gap-2">
        <div
          v-if="dashboards.length"
          class="flex flex-wrap gap-1.5"
          role="tablist"
          :aria-label="$t('ownMetrics.tabs.dashboards')"
        >
          <button
            v-for="d in dashboards"
            :key="d.id"
            type="button"
            role="tab"
            :aria-selected="d.id === selectedId"
            :class="[
              'inline-flex h-8 items-center gap-1.5 rounded-control border px-3 text-13 transition-colors max-lg:h-11',
              d.id === selectedId
                ? 'border-primary bg-primary/10 text-text'
                : 'border-border text-text-muted hover:text-text',
            ]"
            :data-testid="`own-dash-chip-${d.id}`"
            @click="d.id !== selectedId && guarded(() => void select(d.id))"
          >
            {{ d.name }}
            <span class="text-12 tabular-nums text-text-subtle">{{ d.widgets }}</span>
          </button>
        </div>
        <button
          v-if="auth.canManage && !atLimit"
          type="button"
          class="inline-flex h-8 items-center gap-1 rounded-control border border-dashed border-border px-3 text-13 text-text-muted transition-colors hover:text-text max-lg:h-11"
          data-testid="own-dash-new"
          @click="guarded(() => ask('new'))"
        >
          <Plus class="size-3.5" aria-hidden="true" />
          {{ $t('ownMetrics.dashboards.new') }}
        </button>
        <span
          v-else-if="auth.canManage && dashboards.length"
          class="text-12 text-text-subtle"
          data-testid="own-dash-limit"
        >
          {{ $t('ownMetrics.dashboards.limit', { n: limits.dashboards }, limits.dashboards) }}
        </span>
        <span class="flex-1" />
        <template v-if="board.data.value && auth.canManage">
          <template v-if="editing">
            <BaseButton variant="ghost" data-testid="own-dash-rename" @click="ask('rename')">
              {{ $t('ownMetrics.dashboards.rename') }}
            </BaseButton>
            <BaseButton
              v-if="!atLimit"
              variant="ghost"
              data-testid="own-dash-copy"
              @click="guarded(() => ask('copy'))"
            >
              {{ $t('ownMetrics.dashboards.duplicate') }}
            </BaseButton>
            <BaseButton variant="ghost" data-testid="own-dash-delete" @click="deleting = true">
              {{ $t('common.delete') }}
            </BaseButton>
            <BaseButton
              variant="secondary"
              data-testid="own-dash-cancel"
              @click="guarded(() => {})"
            >
              {{ $t('common.cancel') }}
            </BaseButton>
            <BaseButton :loading="saving" data-testid="own-dash-done" @click="done">
              {{ $t('ownMetrics.dashboards.done') }}
            </BaseButton>
          </template>
          <BaseButton v-else variant="secondary" data-testid="own-dash-edit" @click="edit()">
            {{ $t('ownMetrics.dashboards.edit') }}
          </BaseButton>
        </template>
      </div>

      <!-- No dashboard yet. -->
      <section
        v-if="dashboards.length === 0"
        class="rounded-card border border-border bg-surface-1 px-6 py-10 text-center"
        data-testid="own-dash-empty"
      >
        <h2 class="text-16 font-semibold text-text">
          {{ $t('ownMetrics.dashboards.emptyTitle') }}
        </h2>
        <p class="mx-auto mt-2 max-w-xl text-14 leading-relaxed text-text-muted">
          {{ $t('ownMetrics.dashboards.emptyBody') }}
        </p>
        <BaseButton
          v-if="auth.canManage"
          class="mt-5"
          data-testid="own-dash-first"
          @click="ask('new')"
        >
          {{ $t('ownMetrics.dashboards.new') }}
        </BaseButton>
      </section>

      <ErrorState
        v-else-if="board.error.value && !board.data.value"
        inline
        :message="$t('ownMetrics.dashboards.error')"
        :retrying="board.loading.value"
        @retry="board.load"
      />
      <div v-else-if="board.data.value" class="flex items-start gap-4">
        <div class="min-w-0 flex-1">
          <div
            ref="grid"
            class="grid grid-cols-12 gap-3"
            :class="{ 'select-none': dragging || resizing }"
            data-testid="own-grid"
          >
            <div
              v-for="(w, i) in widgets"
              :key="w.id"
              :data-widget-id="w.id"
              :class="[
                'own-cell relative flex min-w-0 flex-col',
                dragging === w.id ? 'opacity-60' : '',
                editing && panel === w.id ? 'rounded-card ring-2 ring-primary' : '',
              ]"
              :style="{ '--own-span': w.w }"
              :data-span="w.w"
            >
              <div
                v-if="editing"
                class="own-strip"
                role="toolbar"
                :aria-label="$t('ownMetrics.dashboards.widgetTools', { name: w.title })"
              >
                <button
                  type="button"
                  class="own-tool cursor-grab touch-none"
                  :aria-label="$t('ownMetrics.dashboards.drag', { name: w.title })"
                  :title="$t('ownMetrics.dashboards.dragHint')"
                  data-testid="own-w-drag"
                  @pointerdown.prevent="dragStart($event, w.id)"
                  @pointermove="dragMove"
                  @pointerup="dragEnd"
                  @pointercancel="dragEnd"
                  @keydown="handleKey($event, w.id, 'move')"
                >
                  <GripVertical class="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="own-tool"
                  :disabled="i === 0"
                  :aria-label="$t('ownMetrics.dashboards.earlier', { name: w.title })"
                  data-testid="own-w-earlier"
                  @click="move(w.id, -1)"
                >
                  <ArrowLeft class="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="own-tool"
                  :disabled="i === widgets.length - 1"
                  :aria-label="$t('ownMetrics.dashboards.later', { name: w.title })"
                  data-testid="own-w-later"
                  @click="move(w.id, 1)"
                >
                  <ArrowRight class="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="own-tool"
                  :disabled="w.w === 3"
                  :aria-label="$t('ownMetrics.dashboards.narrower', { name: w.title })"
                  data-testid="own-w-narrower"
                  @click="resize(w.id, -1)"
                >
                  <Minus class="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="own-tool"
                  :disabled="w.w === 12"
                  :aria-label="$t('ownMetrics.dashboards.wider', { name: w.title })"
                  data-testid="own-w-wider"
                  @click="resize(w.id, 1)"
                >
                  <Plus class="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="own-tool"
                  :aria-label="$t('ownMetrics.dashboards.change', { name: w.title })"
                  data-testid="own-w-edit"
                  @click="panel = w.id"
                >
                  <Pencil class="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="own-tool"
                  :aria-label="$t('ownMetrics.dashboards.remove', { name: w.title })"
                  data-testid="own-w-remove"
                  @click="remove(w.id)"
                >
                  <Trash2 class="size-4" aria-hidden="true" />
                </button>
              </div>
              <DashboardWidget
                :widget="w"
                :tick="tick"
                :current-cluster="cluster.id"
                :plain="editing"
              />
              <button
                v-if="editing"
                type="button"
                class="own-corner touch-none max-lg:hidden"
                :aria-label="$t('ownMetrics.dashboards.corner', { name: w.title })"
                data-testid="own-w-corner"
                @pointerdown.prevent="sizeStart($event, w.id)"
                @pointermove="sizeMove"
                @pointerup="sizeEnd"
                @pointercancel="sizeEnd"
                @keydown="handleKey($event, w.id, 'size')"
              />
            </div>
            <button
              v-if="editing && !full"
              type="button"
              class="own-cell flex min-h-28 items-center justify-center gap-1.5 rounded-card border border-dashed border-border text-14 text-text-muted transition-colors hover:border-primary hover:text-text"
              :style="{ '--own-span': 3 }"
              data-testid="own-w-add"
              @click="panel = 'new'"
            >
              <Plus class="size-4" aria-hidden="true" />
              {{ $t('ownMetrics.editor.add') }}
            </button>
          </div>
          <p v-if="editing && full" class="mt-3 text-13 text-text-muted" data-testid="own-w-full">
            {{ $t('ownMetrics.dashboards.widgetLimit', { n: limits.widgetsPerDashboard }) }}
          </p>
          <p
            v-if="!editing && widgets.length === 0"
            class="rounded-card border border-border bg-surface-1 px-5 py-6 text-14 text-text-muted"
            data-testid="own-dash-nowidgets"
          >
            {{ $t('ownMetrics.dashboards.noWidgets') }}
          </p>
        </div>

        <!-- The side panel (a sheet on a phone). -->
        <aside
          v-if="editing && panel && !narrow"
          class="sticky top-4 w-[22rem] shrink-0 rounded-card border border-border bg-surface-1 px-4 py-4"
        >
          <WidgetEditor
            :key="panel"
            :widget="panelWidget"
            :metrics="metrics"
            :cluster="cluster"
            :taken="draft"
            @apply="apply"
            @close="panel = null"
          />
        </aside>
        <ModalDialog
          v-else-if="editing && panel && narrow"
          :open="true"
          :title="$t(panelWidget ? 'ownMetrics.editor.change' : 'ownMetrics.editor.add')"
          @update:open="(v) => !v && (panel = null)"
        >
          <WidgetEditor
            :key="panel"
            :widget="panelWidget"
            :metrics="metrics"
            :cluster="cluster"
            :taken="draft"
            @apply="apply"
            @close="panel = null"
          />
        </ModalDialog>
      </div>
    </template>

    <ModalDialog
      v-model:open="nameOpen"
      :title="$t(`ownMetrics.dashboards.naming.${naming ?? 'new'}`)"
    >
      <form
        class="flex flex-col gap-4"
        data-testid="own-dash-name-form"
        @submit.prevent="submitName"
      >
        <TextField
          v-model="name"
          :label="$t('ownMetrics.dashboards.name')"
          :error="nameError"
          :maxlength="80"
          required
        />
        <div class="flex justify-end gap-2">
          <BaseButton variant="secondary" @click="naming = null">{{
            $t('common.cancel')
          }}</BaseButton>
          <BaseButton type="submit" :loading="saving" data-testid="own-dash-name-save">
            {{ $t(naming === 'rename' ? 'common.save' : 'ownMetrics.dashboards.create') }}
          </BaseButton>
        </div>
      </form>
    </ModalDialog>

    <ConfirmDialog
      v-model:open="deleting"
      :title="$t('ownMetrics.dashboards.deleteTitle')"
      :subject="board.data.value?.name"
      :lines="[$t('ownMetrics.dashboards.deleteBody')]"
      :confirm-label="$t('ownMetrics.dashboards.deleteConfirm')"
      :action="removeBoard"
      testid="own-dash-delete-confirm"
    />

    <ModalDialog v-model:open="askLeave" :title="$t('ownMetrics.dashboards.unsavedTitle')">
      <p class="text-14 leading-relaxed text-text-muted">
        {{ $t('ownMetrics.dashboards.unsavedBody') }}
      </p>
      <div class="flex justify-end gap-2">
        <BaseButton variant="secondary" data-testid="own-dash-keep" @click="leaving = null">
          {{ $t('ownMetrics.dashboards.keepEditing') }}
        </BaseButton>
        <BaseButton variant="danger" data-testid="own-dash-discard" @click="discard">
          {{ $t('ownMetrics.dashboards.discard') }}
        </BaseButton>
      </div>
    </ModalDialog>
  </div>
</template>

<style scoped>
/* A widget spans its columns of 12; on a phone every widget is one full row. */
.own-cell {
  grid-column: span var(--own-span) / span var(--own-span);
}
@media (max-width: 1023px) {
  .own-cell {
    grid-column: span 6 / span 6;
  }
  .own-cell[data-span='8'],
  .own-cell[data-span='12'] {
    grid-column: span 12 / span 12;
  }
}
@media (max-width: 767px) {
  .own-cell,
  .own-cell[data-span] {
    grid-column: span 12 / span 12;
  }
}
/* The tools of a widget in edit mode: a strip above it, wrapping on a narrow widget. */
.own-strip {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-bottom: 4px;
}
.own-tool {
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-control);
  color: var(--text-subtle);
}
.own-tool:hover:not(:disabled),
.own-tool:focus-visible {
  background: var(--surface-3);
  color: var(--text);
}
.own-tool:disabled {
  opacity: 0.35;
}
@media (max-width: 1023px) {
  .own-tool {
    width: 44px;
    height: 44px;
  }
}
.own-corner {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 18px;
  height: 18px;
  cursor: nwse-resize;
  border-right: 2px solid var(--border-strong);
  border-bottom: 2px solid var(--border-strong);
  border-bottom-right-radius: var(--radius-card);
}
.own-corner:hover,
.own-corner:focus-visible {
  border-color: var(--primary);
}
</style>
