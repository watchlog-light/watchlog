<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Maximize, Minus, Plus, RotateCcw } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Layout, Pos } from '@/lib/servicemap-layout';
import {
  curve,
  lengthOf,
  pathOf,
  placeLabels,
  pointAt,
  type Curve,
} from '@/lib/servicemap-geometry';

// The live graph of the service map (ADR-109):
// SVG for namespaces, edges, nodes, labels and badges (clickable, focusable), a canvas
// on top for the particles that show live traffic. Zoom only with ⌘/Ctrl + wheel, a
// pinch or the buttons; a plain wheel scrolls the page and shows a hint. Positions come
// from the parent (stable layout); dragging a node reports its new position.
export type Health = 'ok' | 'warning' | 'critical' | 'idle' | 'unknown';
export interface DrawNode {
  id: string;
  title: string;
  label: string;
  health: Health;
  group: string;
  shape: 'service' | 'database' | 'external' | 'node';
}
export interface DrawEdge {
  id: string;
  source: string;
  target: string;
  health: Health;
  label: string;
  particles: number;
  width: number;
  speed: number;
  badge: string | null;
}
export interface DrawGroup {
  key: string;
  label: string;
  /** A design-token colour, e.g. var(--chart-2). */
  color: string;
}
export type Selection = { type: 'node' | 'edge'; id: string } | null;

const props = defineProps<{
  nodes: DrawNode[];
  edges: DrawEdge[];
  groups: DrawGroup[];
  positions: Layout;
  selected: Selection;
}>();
const emit = defineEmits<{
  select: [sel: Selection];
  move: [id: string, pos: Pos, done: boolean];
  resetLayout: [];
}>();
const { t } = useI18n();

const R = { service: 20, database: 20, external: 26, node: 22 } as const;
const box = ref<HTMLDivElement>();
const svg = ref<SVGSVGElement>();
const canvas = ref<HTMLCanvasElement>();
const size = reactive({ w: 900, h: 600 });
const view = reactive({ k: 1, tx: 0, ty: 0 });
const hover = ref<Selection>(null);
const hint = ref(false);

const byId = computed(() => new Map(props.nodes.map((n) => [n.id, n])));
const pos = (id: string) => props.positions[id] ?? { x: 0, y: 0 };

const curves = computed(() => {
  const out = new Map<string, { c: Curve; len: number }>();
  for (const e of props.edges) {
    const a = byId.value.get(e.source);
    const b = byId.value.get(e.target);
    if (!a || !b) continue;
    const c = curve(pos(e.source), pos(e.target), R[a.shape], R[b.shape] + 4);
    out.set(e.id, { c, len: lengthOf(c) });
  }
  return out;
});

const groupBoxes = computed(() =>
  props.groups.flatMap((g) => {
    const members = props.nodes.filter((n) => n.group === g.key);
    if (!members.length) return [];
    const xs = members.map((n) => pos(n.id).x);
    const ys = members.map((n) => pos(n.id).y);
    const x0 = Math.min(...xs) - 74;
    const y0 = Math.min(...ys) - 58;
    return [
      {
        ...g,
        x: x0,
        y: y0,
        w: Math.max(...xs) + 74 - x0,
        h: Math.max(...ys) + 52 - y0,
        count: members.length,
      },
    ];
  }),
);

/** What stays bright while a node or edge is hovered or selected. */
const focus = computed(() => {
  const f = hover.value ?? props.selected;
  if (!f) return null;
  const nodes = new Set<string>();
  const edges = new Set<string>();
  if (f.type === 'node') {
    nodes.add(f.id);
    for (const e of props.edges)
      if (e.source === f.id || e.target === f.id) {
        edges.add(e.id);
        nodes.add(e.source);
        nodes.add(e.target);
      }
  } else {
    const e = props.edges.find((x) => x.id === f.id);
    if (e) {
      edges.add(e.id);
      nodes.add(e.source);
      nodes.add(e.target);
    }
  }
  return { nodes, edges };
});
const fadedNode = (id: string) => !!focus.value && !focus.value.nodes.has(id);
const fadedEdge = (id: string) => !!focus.value && !focus.value.edges.has(id);

const labels = computed(() => {
  const degree = new Map<string, number>();
  for (const e of props.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return placeLabels(
    props.nodes.map((n) => ({
      id: n.id,
      ...pos(n.id),
      text: n.label,
      force: !!focus.value?.nodes.has(n.id),
      priority:
        n.health === 'critical' || n.health === 'warning'
          ? 3
          : (degree.get(n.id) ?? 0) >= 3
            ? 2
            : 1,
    })),
    view.k,
    38,
  );
});

const badges = computed(() =>
  props.edges.flatMap((e) => {
    const c = curves.value.get(e.id);
    if (!e.badge || !c) return [];
    const m = pointAt(c.c, 0.5);
    return [
      { id: e.id, x: m.x, y: m.y, w: e.badge.length * 6.4 + 14, text: e.badge, health: e.health },
    ];
  }),
);

// ── View transform ───────────────────────────────────────────────────────────────
function toWorld(clientX: number, clientY: number) {
  const r = svg.value!.getBoundingClientRect();
  return { x: (clientX - r.left - view.tx) / view.k, y: (clientY - r.top - view.ty) / view.k };
}
function zoomAt(sx: number, sy: number, factor: number) {
  const k = Math.max(0.25, Math.min(3, view.k * factor));
  view.tx = sx - (sx - view.tx) * (k / view.k);
  view.ty = sy - (sy - view.ty) * (k / view.k);
  view.k = k;
}
const reduce =
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function animateTo(k: number, tx: number, ty: number) {
  const s = { ...view };
  const t0 = performance.now();
  const dur = reduce ? 0 : 300;
  const step = (now: number) => {
    const p = dur ? Math.min(1, (now - t0) / dur) : 1;
    const e = 1 - (1 - p) ** 3;
    view.k = s.k + (k - s.k) * e;
    view.tx = s.tx + (tx - s.tx) * e;
    view.ty = s.ty + (ty - s.ty) * e;
    if (p < 1) requestAnimationFrame(step);
  };
  if (dur) requestAnimationFrame(step);
  else step(t0);
}
function fit(animate = true) {
  if (!props.nodes.length) return;
  const xs = props.nodes.map((n) => pos(n.id).x);
  const ys = props.nodes.map((n) => pos(n.id).y);
  const x0 = Math.min(...xs) - 100;
  const x1 = Math.max(...xs) + 100;
  const y0 = Math.min(...ys) - 80;
  const y1 = Math.max(...ys) + 70;
  const k = Math.max(0.25, Math.min(1.4, size.w / (x1 - x0), size.h / (y1 - y0)));
  const tx = size.w / 2 - ((x0 + x1) / 2) * k;
  const ty = size.h / 2 - ((y0 + y1) / 2) * k;
  if (animate) animateTo(k, tx, ty);
  else Object.assign(view, { k, tx, ty });
}
function focusNode(id: string) {
  const p = props.positions[id];
  if (!p) return;
  const k = Math.max(view.k, 1.3);
  animateTo(k, size.w / 2 - p.x * k, size.h / 2 - p.y * k);
}
function focusEdge(id: string) {
  const c = curves.value.get(id);
  if (!c) return;
  const m = pointAt(c.c, 0.5);
  const k = Math.max(view.k, 1.1);
  animateTo(k, size.w / 2 - m.x * k, size.h / 2 - m.y * k);
}
defineExpose({ fit, focusNode, focusEdge });

let hintTimer: ReturnType<typeof setTimeout> | undefined;
function onWheel(e: WheelEvent) {
  if (e.ctrlKey || e.metaKey) {
    // ⌘/Ctrl + wheel, and trackpad pinches (reported as wheel + ctrlKey).
    e.preventDefault();
    const r = svg.value!.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0025));
    return;
  }
  hint.value = true;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => (hint.value = false), 1400);
}

// ── Pointers: pan the background, drag nodes, pinch with two fingers ─────────────
type Drag =
  | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number; moved: boolean }
  | { kind: 'node'; id: string; dx: number; dy: number; moved: boolean; sx: number; sy: number };
let drag: Drag | null = null;
const pointers = new Map<number, { x: number; y: number }>();
let pinch: { d: number; k: number } | null = null;

function onBackgroundDown(e: PointerEvent) {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), k: view.k };
    drag = null;
    return;
  }
  drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty, moved: false };
  svg.value?.setPointerCapture?.(e.pointerId);
}
function onNodeDown(e: PointerEvent, id: string) {
  e.stopPropagation();
  const w = toWorld(e.clientX, e.clientY);
  const p = pos(id);
  drag = {
    kind: 'node',
    id,
    dx: p.x - w.x,
    dy: p.y - w.y,
    moved: false,
    sx: e.clientX,
    sy: e.clientY,
  };
  svg.value?.setPointerCapture?.(e.pointerId);
}
function onMove(e: PointerEvent) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const r = svg.value!.getBoundingClientRect();
    const cx = (a!.x + b!.x) / 2 - r.left;
    const cy = (a!.y + b!.y) / 2 - r.top;
    zoomAt(cx, cy, (pinch.k * (Math.hypot(a!.x - b!.x, a!.y - b!.y) / pinch.d)) / view.k);
    return;
  }
  if (!drag) return;
  const far = Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3;
  if (drag.kind === 'pan') {
    if (far) drag.moved = true;
    view.tx = drag.tx + e.clientX - drag.sx;
    view.ty = drag.ty + e.clientY - drag.sy;
  } else if (far || drag.moved) {
    drag.moved = true;
    const w = toWorld(e.clientX, e.clientY);
    emit(
      'move',
      drag.id,
      { x: Math.round(w.x + drag.dx), y: Math.round(w.y + drag.dy), pinned: true },
      false,
    );
  }
}
function onUp(e: PointerEvent) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  const d = drag;
  drag = null;
  if (!d) return;
  if (d.kind === 'pan' && !d.moved) emit('select', null);
  if (d.kind === 'node') {
    if (d.moved) emit('move', d.id, { ...pos(d.id), pinned: true }, true);
    else emit('select', { type: 'node', id: d.id });
  }
}
function onEdgeClick(id: string) {
  emit('select', { type: 'edge', id });
}

// ── Particles on a canvas over the SVG ───────────────────────────────────────────
const colors: Record<string, string> = {};
function readColors() {
  const s = canvas.value ? getComputedStyle(canvas.value) : null;
  for (const [h, token] of [
    ['ok', '--ok'],
    ['warning', '--warning'],
    ['critical', '--critical'],
  ] as const)
    colors[h] = s?.getPropertyValue(token).trim() || 'currentColor';
}
let raf = 0;
function draw(now: number) {
  const cv = canvas.value;
  const ctx = cv?.getContext?.('2d');
  if (!cv || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(size.w * dpr) || cv.height !== Math.round(size.h * dpr)) {
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.tx, dpr * view.ty);
  for (const e of props.edges) {
    if (!e.particles) continue;
    const c = curves.value.get(e.id);
    if (!c) continue;
    ctx.fillStyle = colors[e.health] ?? colors.ok!;
    ctx.globalAlpha = fadedEdge(e.id) ? 0.1 : 1;
    const r = e.health === 'critical' ? 2.8 : 2.4;
    for (let i = 0; i < e.particles; i++) {
      const tt = reduce
        ? (i + 0.5) / e.particles
        : (((now / 1000) * e.speed) / c.len + i / e.particles) % 1;
      // Failing edges: some particles fade out before they arrive.
      if (e.health === 'critical' && !reduce && i % 3 === 0 && tt > 0.7)
        ctx.globalAlpha = Math.max(0, 1 - (tt - 0.7) * 4) * (fadedEdge(e.id) ? 0.1 : 1);
      const p = pointAt(c.c, tt);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = fadedEdge(e.id) ? 0.1 : 1;
    }
  }
  ctx.globalAlpha = 1;
}
function loop(now: number) {
  draw(now);
  raf = requestAnimationFrame(loop);
}
// With reduced motion the particles stand still: redraw only when something changes.
watch(
  () => [props.edges, props.positions, view.k, view.tx, view.ty, focus.value],
  () => reduce && draw(0),
  { deep: false },
);

let resize: ResizeObserver | undefined;
let fitted = false;
onMounted(async () => {
  const measure = () => {
    const r = box.value?.getBoundingClientRect();
    if (r && r.width > 0) Object.assign(size, { w: r.width, h: r.height });
  };
  measure();
  if (typeof ResizeObserver !== 'undefined') {
    resize = new ResizeObserver(measure);
    if (box.value) resize.observe(box.value);
  }
  readColors();
  await nextTick();
  fit(false);
  fitted = props.nodes.length > 0;
  if (reduce) draw(0);
  else raf = requestAnimationFrame(loop);
});
// The first data that has nodes is fitted once; refreshes never move the view.
watch(
  () => props.nodes.length,
  (n) => {
    if (!fitted && n > 0) {
      fitted = true;
      void nextTick(() => fit(false));
    }
  },
);
onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  resize?.disconnect();
  clearTimeout(hintTimer);
});

const nodeAria = (n: DrawNode) => `${n.title}, ${t(`serviceMap.health.${n.health}`)}`;
</script>

<template>
  <div ref="box" class="map-box relative h-full w-full overflow-hidden" data-testid="map-canvas">
    <svg
      ref="svg"
      class="block h-full w-full cursor-grab touch-none select-none"
      :class="{ 'cursor-grabbing': drag?.kind === 'pan' }"
      role="group"
      :aria-label="$t('serviceMap.graphLabel')"
      @wheel="onWheel"
      @pointerdown="onBackgroundDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    >
      <defs>
        <marker
          v-for="h in ['ok', 'warning', 'critical', 'idle', 'unknown']"
          :id="`wl-arrow-${h}`"
          :key="h"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0L10 5L0 10z" :class="`fill-${h}`" />
        </marker>
        <filter id="wl-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g :transform="`translate(${view.tx} ${view.ty}) scale(${view.k})`">
        <g data-layer="groups">
          <g v-for="g in groupBoxes" :key="g.key" data-testid="map-group">
            <rect
              :x="g.x"
              :y="g.y"
              :width="g.w"
              :height="g.h"
              rx="14"
              class="group-box"
              :style="{ fill: g.color, stroke: g.color }"
            />
            <text :x="g.x + 12" :y="g.y + 18" class="group-label">
              {{ g.label }} · {{ g.count }}
            </text>
          </g>
        </g>
        <g data-layer="edges">
          <g
            v-for="e in edges"
            :key="e.id"
            :class="{ faded: fadedEdge(e.id) }"
            data-testid="map-edge"
            :data-edge="e.id"
            :data-health="e.health"
          >
            <path
              v-if="curves.get(e.id)"
              :d="pathOf(curves.get(e.id)!.c)"
              class="edge"
              :class="[
                `edge-${e.health}`,
                { 'edge-selected': selected?.type === 'edge' && selected.id === e.id },
              ]"
              :stroke-width="e.width"
              :marker-end="`url(#wl-arrow-${e.health})`"
              :filter="e.health === 'critical' ? 'url(#wl-glow)' : undefined"
            />
            <path
              v-if="curves.get(e.id)"
              :d="pathOf(curves.get(e.id)!.c)"
              class="edge-hit"
              role="button"
              :aria-label="e.label"
              @pointerdown.stop
              @click.stop="onEdgeClick(e.id)"
              @mouseenter="hover = { type: 'edge', id: e.id }"
              @mouseleave="hover = null"
            />
          </g>
        </g>
        <g data-layer="badges">
          <g
            v-for="b in badges"
            :key="b.id"
            class="cursor-pointer"
            :class="{ faded: fadedEdge(b.id) }"
            data-testid="map-badge"
            @pointerdown.stop
            @click.stop="onEdgeClick(b.id)"
          >
            <rect
              :x="b.x - b.w / 2"
              :y="b.y - 10"
              :width="b.w"
              height="18"
              rx="9"
              class="badge-bg"
              :class="`stroke-${b.health}`"
            />
            <text
              :x="b.x"
              :y="b.y + 3.5"
              text-anchor="middle"
              class="badge-text"
              :class="`fill-${b.health}`"
            >
              {{ b.text }}
            </text>
          </g>
        </g>
        <g data-layer="nodes">
          <g
            v-for="n in nodes"
            :key="n.id"
            class="map-node cursor-pointer outline-none"
            :class="{ faded: fadedNode(n.id) }"
            :transform="`translate(${pos(n.id).x} ${pos(n.id).y})`"
            role="button"
            tabindex="0"
            :aria-label="nodeAria(n)"
            :aria-pressed="selected?.type === 'node' && selected.id === n.id"
            data-testid="map-node"
            :data-node="n.id"
            @pointerdown="onNodeDown($event, n.id)"
            @keydown.enter.prevent="emit('select', { type: 'node', id: n.id })"
            @keydown.space.prevent="emit('select', { type: 'node', id: n.id })"
            @mouseenter="hover = { type: 'node', id: n.id }"
            @mouseleave="hover = null"
          >
            <title>{{ n.title }}</title>
            <template v-if="n.shape === 'external'">
              <rect
                x="-30"
                y="-16"
                width="60"
                height="32"
                rx="8"
                class="node-body stroke-warning"
              />
              <g transform="translate(-7 -7)" class="node-icon stroke-warning">
                <circle cx="7" cy="7" r="6.5" />
                <path d="M0.5 7h13M7 0.5c2.2 2.4 2.2 10.6 0 13M7 0.5c-2.2 2.4-2.2 10.6 0 13" />
              </g>
            </template>
            <template v-else>
              <circle
                v-if="n.health === 'critical' || n.health === 'warning'"
                r="26"
                class="node-ring"
                :class="`stroke-${n.health}`"
              />
              <circle
                r="20"
                class="node-body"
                :class="
                  n.health === 'critical' || n.health === 'warning' ? `stroke-${n.health}` : ''
                "
                :style="
                  n.health === 'critical' || n.health === 'warning'
                    ? undefined
                    : { stroke: groups.find((g) => g.key === n.group)?.color }
                "
              />
              <g
                v-if="n.shape === 'database'"
                transform="translate(-7 -8)"
                class="node-icon stroke-text-muted"
              >
                <ellipse cx="7" cy="3" rx="6.5" ry="2.6" />
                <path
                  d="M0.5 3v10c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6V3M0.5 8c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6"
                />
              </g>
              <g
                v-else-if="n.shape === 'node'"
                transform="translate(-7 -7)"
                class="node-icon stroke-text-muted"
              >
                <rect x="0.5" y="1" width="13" height="5" rx="1.2" />
                <rect x="0.5" y="8" width="13" height="5" rx="1.2" />
              </g>
              <g v-else transform="translate(-7 -7)" class="node-icon stroke-text-muted">
                <path d="M7 0.5l6 3.4v6.2l-6 3.4-6-3.4V3.9z M1 3.9l6 3.4 6-3.4 M7 7.3v6.2" />
              </g>
              <g v-if="n.health === 'critical'" transform="translate(14 -16)" aria-hidden="true">
                <circle r="7" class="fill-critical" />
                <text y="3.5" text-anchor="middle" class="alert-mark">!</text>
              </g>
            </template>
            <text
              v-if="labels.get(n.id)"
              :y="labels.get(n.id)!.y - pos(n.id).y"
              text-anchor="middle"
              class="node-label"
            >
              {{ n.label }}
            </text>
          </g>
        </g>
      </g>
    </svg>
    <canvas
      ref="canvas"
      class="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden="true"
    />

    <div class="absolute top-2.5 right-2.5 flex flex-col gap-1">
      <button
        v-for="b in [
          { key: 'in', icon: Plus, run: () => zoomAt(size.w / 2, size.h / 2, 1.25) },
          { key: 'out', icon: Minus, run: () => zoomAt(size.w / 2, size.h / 2, 0.8) },
          { key: 'fit', icon: Maximize, run: () => fit() },
          { key: 'reset', icon: RotateCcw, run: () => emit('resetLayout') },
        ]"
        :key="b.key"
        type="button"
        class="flex size-8 items-center justify-center rounded-control border border-border-strong bg-surface-2 text-text-muted hover:text-text"
        :aria-label="$t(`serviceMap.tools.${b.key}`)"
        :title="$t(`serviceMap.tools.${b.key}`)"
        :data-testid="`map-${b.key}`"
        @click="b.run"
      >
        <component :is="b.icon" class="size-4" aria-hidden="true" />
      </button>
    </div>
    <div
      class="pointer-events-none absolute bottom-3.5 left-1/2 -translate-x-1/2 rounded-control border border-border-strong bg-surface-3 px-2.5 py-1 text-12 text-text-muted transition-opacity"
      :class="hint ? 'opacity-100' : 'opacity-0'"
      role="status"
      data-testid="zoom-hint"
    >
      {{ $t('serviceMap.zoomHint') }}
    </div>
    <slot name="footer" />
  </div>
</template>

<style scoped>
.group-box {
  fill-opacity: 0.035;
  stroke-opacity: 0.28;
  stroke-dasharray: 4 5;
}
.group-label {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  fill: var(--text-subtle);
}
.edge {
  fill: none;
}
.edge-ok {
  stroke: var(--ok);
  stroke-opacity: 0.7;
}
.edge-warning {
  stroke: var(--warning);
  stroke-opacity: 0.9;
}
.edge-critical {
  stroke: var(--critical);
  stroke-opacity: 0.9;
}
.edge-idle,
.edge-unknown {
  stroke: var(--text-subtle);
  stroke-opacity: 0.8;
  stroke-dasharray: 4 5;
}
.edge-selected {
  stroke-opacity: 1;
}
.edge-hit {
  stroke: transparent;
  stroke-width: 14;
  fill: none;
  cursor: pointer;
}
.fill-ok {
  fill: var(--ok);
}
.fill-warning {
  fill: var(--warning);
}
.fill-critical {
  fill: var(--critical);
}
.fill-idle,
.fill-unknown {
  fill: var(--text-subtle);
}
.stroke-ok {
  stroke: var(--ok);
}
.stroke-warning {
  stroke: var(--warning);
}
.stroke-critical {
  stroke: var(--critical);
}
.stroke-idle,
.stroke-unknown {
  stroke: var(--text-subtle);
}
.stroke-text-muted {
  stroke: var(--text-muted);
}
.badge-bg {
  fill: var(--surface-1);
}
.badge-text {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
}
.node-body {
  fill: var(--surface-2);
  stroke-width: 2;
}
.node-ring {
  fill: none;
  stroke-opacity: 0.35;
  stroke-width: 5;
}
.node-icon {
  fill: none;
  stroke-width: 1.6;
}
.alert-mark {
  font-size: 10px;
  font-weight: 700;
  fill: var(--text);
}
.node-label {
  font-size: 12px;
  fill: var(--text);
  paint-order: stroke;
  stroke: var(--bg);
  stroke-width: 4px;
  stroke-linejoin: round;
  pointer-events: none;
}
.map-node:focus-visible .node-body {
  stroke: var(--primary);
  stroke-width: 3;
}
.faded {
  opacity: 0.12;
}
</style>
