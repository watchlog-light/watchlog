<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { Maximize, Minus, Plus, RotateCcw, X } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import SearchField from '@/components/ui/SearchField.vue';
import { useMotion } from '@/composables/useMotion';
import { useAuthStore } from '@/stores/auth';
import { networkApi, type Endpoint, type Link, type MapData } from '../api';
import { bpsText, pct, speedLong, speedText, uptimeText } from '../lib/format';
import {
  deviceNodeId,
  flowOf,
  focusOf,
  layoutMap,
  linkTone,
  linkWidth,
  searchMap,
  type MapEdge,
  type MapNode,
  type SearchHit,
  type Tone,
} from '../lib/map-layout';
import KindIcon from './KindIcon.vue';

// The network map (ADR-233): bands from the Internet down to the devices, laid out once per
// data change (lib/map-layout.ts); links as thick as they are fast, moving dashes for their
// traffic (still dashes under reduced motion), red and dashed when down, amber when busy.
// Picking a device or a link lights up its way to the Internet and docks the details panel
// beside the canvas (below it on phones). An Owner's or Admin's dragged positions are saved
// for the organisation. `compact` is the Overview's small copy: no panel, a click opens the
// Map tab on that device.
const props = withDefaults(defineProps<{ data: MapData; compact?: boolean; focus?: string }>(), {
  compact: false,
  focus: undefined,
});
const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();

type Pos = { x: number; y: number };
type Sel = { type: 'node' | 'link'; id: string };

const layers = reactive({ utilisation: true, endpoints: false });
const expanded = ref<Set<string>>(new Set());
const layout = computed(() =>
  layoutMap(props.data, { endpoints: layers.endpoints, expanded: expanded.value }),
);
const devName = computed(() => new Map(props.data.devices.map((d) => [d.id, d.name])));

// ── Positions: computed, then saved (MapData.layout), then dragged here ─────────────────
const saved = ref<Record<string, Pos>>({ ...props.data.layout });
watch(
  () => props.data.layout,
  (l) => (saved.value = { ...l }),
);
const moved = reactive<Record<string, Pos>>({});
const pos = (id: string): Pos =>
  moved[id] ?? saved.value[id] ?? layout.value.byId.get(id) ?? { x: 0, y: 0 };
const customised = computed(
  () => Object.keys(moved).length > 0 || Object.keys(saved.value).length > 0,
);

const saveState = ref<'idle' | 'saved' | 'error' | 'viewer'>('idle');
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save(positions: Record<string, Pos>) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    networkApi
      .saveLayout(positions)
      .then(() => (saveState.value = 'saved'))
      .catch(() => (saveState.value = 'error'));
  }, 800);
}
function onMoved() {
  if (!auth.canManage) {
    saveState.value = 'viewer';
    return;
  }
  save({ ...saved.value, ...moved });
}
function resetLayout() {
  for (const k of Object.keys(moved)) delete moved[k];
  saved.value = {};
  save({});
  void nextTick(() => fit());
}

// ── Selection and focus ──────────────────────────────────────────────────────────────────
const selected = ref<Sel | null>(null);
const hover = ref<string | null>(null);
const focusSet = computed(() =>
  selected.value && !props.compact ? focusOf(layout.value, selected.value) : null,
);
const selNode = computed(() =>
  selected.value?.type === 'node' ? layout.value.byId.get(selected.value.id) : undefined,
);
const selEdge = computed(() =>
  selected.value?.type === 'link'
    ? layout.value.edges.find((e) => e.id === selected.value!.id)
    : undefined,
);
// A refresh or a layer that drops the picked node closes the panel.
watch(layout, (l) => {
  const s = selected.value;
  if (s && (s.type === 'node' ? !l.byId.has(s.id) : !l.edges.some((e) => e.id === s.id)))
    selected.value = null;
});

// ── Drawing ──────────────────────────────────────────────────────────────────────────────
const RADIUS: Record<MapNode['type'], number> = {
  internet: 28,
  device: 28,
  host: 28,
  group: 18,
  endpoint: 14,
};
const view = reactive({ k: 1, tx: 0, ty: 0 });
const size = reactive({ w: 900, h: 600 });

const drawNodes = computed(() => {
  const f = focusSet.value;
  const sel = selected.value?.type === 'node' ? selected.value.id : null;
  const names = view.k >= 0.4;
  const subs = view.k >= 0.75 && !props.compact;
  return layout.value.nodes.map((n) => {
    const p = pos(n.id);
    return {
      n,
      x: p.x,
      y: p.y,
      r: RADIUS[n.type],
      faded: !!f && !f.nodes.has(n.id),
      selected: sel === n.id,
      name: names || sel === n.id,
      sub: subs && n.type !== 'group' && !!n.sub,
    };
  });
});

/** Labels share a slot with their neighbours: a long name is cut (the tooltip has it whole). */
const LABEL_MAX = 16;
function nodeName(n: MapNode): string {
  if (n.type === 'internet') return t('netMap.internet');
  if (n.type === 'group') return t('netMap.more', { n: n.behind });
  return n.name.length > LABEL_MAX ? `${n.name.slice(0, LABEL_MAX - 1)}…` : n.name;
}
const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-ok-text',
  warning: 'text-warning-text',
  critical: 'text-critical-text',
  neutral: 'text-text-muted',
};
function statusText(n: MapNode): string {
  const d = n.device;
  if (!d) return '';
  if (d.status === 'ok' && d.openAlerts > 0) return t('net.status.warning');
  return t(`net.status.${d.status}`);
}
function kindText(n: MapNode): string {
  return n.type === 'endpoint' || n.type === 'group'
    ? t('netMap.unknownEndpoint')
    : t(`net.kind.${n.kind}`);
}
const nodeAria = (n: MapNode) =>
  t('netMap.nodeAria', { name: nodeName(n), kind: kindText(n), status: statusText(n) || '–' });

function linkText(l: Link): string {
  if (l.state === 'down') return t('netMap.down', { port: l.a.port });
  return `${speedText(l.speedMbps)} · ${pct(l.utilisation)}`;
}

const drawEdges = computed(() => {
  const f = focusSet.value;
  const sel = selected.value?.type === 'link' ? selected.value.id : null;
  return layout.value.edges.map((e) => {
    const a = pos(e.from);
    const b = pos(e.to);
    const na = layout.value.byId.get(e.from);
    const nb = layout.value.byId.get(e.to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const ra = na ? RADIUS[na.type] : 0;
    const rb = nb ? RADIUS[nb.type] : 0;
    const ox = -uy * e.offset;
    const oy = ux * e.offset;
    const l = e.link;
    const tone = l ? linkTone(l) : e.down ? 'critical' : 'quiet';
    const isSel = sel === e.id;
    const label =
      !!l &&
      !props.compact &&
      (isSel ||
        l.state !== 'ok' ||
        (layers.utilisation &&
          ((l.speedMbps ?? 0) >= 10000 || (na?.band ?? 4) <= 2 || (nb?.band ?? 4) <= 2)));
    return {
      e,
      x1: a.x + ux * ra + ox,
      y1: a.y + uy * ra + oy,
      x2: b.x - ux * rb + ox,
      y2: b.y - uy * rb + oy,
      tone,
      width: l ? linkWidth(l.speedMbps) : 1.2,
      flow: l && layers.utilisation ? flowOf(l) : null,
      faded: !!f && !f.edges.has(e.id),
      selected: isSel,
      label: label ? linkText(l!) : '',
    };
  });
});

const linkAria = (e: MapEdge) =>
  e.link
    ? t('netMap.linkAria', {
        a: devName.value.get(e.link.a.deviceId) ?? '',
        b: devName.value.get(e.link.b.deviceId) ?? '',
        text: linkText(e.link),
      })
    : '';

// ── View: zoom, pan, fit ─────────────────────────────────────────────────────────────────
const box = ref<HTMLDivElement | null>(null);
const svg = ref<SVGSVGElement>();
const motion = useMotion(box);
const reduce = computed(() => motion.value === 'off');

function zoomAt(sx: number, sy: number, factor: number) {
  const k = Math.max(0.08, Math.min(3, view.k * factor));
  view.tx = sx - (sx - view.tx) * (k / view.k);
  view.ty = sy - (sy - view.ty) * (k / view.k);
  view.k = k;
}
let anim = 0;
function animateTo(k: number, tx: number, ty: number) {
  cancelAnimationFrame(anim);
  const s = { ...view };
  const t0 = performance.now();
  const dur = reduce.value ? 0 : 280;
  const step = (now: number) => {
    const p = dur ? Math.min(1, (now - t0) / dur) : 1;
    const e = 1 - (1 - p) ** 3;
    view.k = s.k + (k - s.k) * e;
    view.tx = s.tx + (tx - s.tx) * e;
    view.ty = s.ty + (ty - s.ty) * e;
    if (p < 1) anim = requestAnimationFrame(step);
  };
  if (dur) anim = requestAnimationFrame(step);
  else step(t0);
}
function fit(animate = true) {
  const list = layout.value.nodes;
  if (!list.length) return;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const n of list) {
    const p = pos(n.id);
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  // Room for the band labels on the left and the names under the lowest row.
  x0 -= 90;
  x1 += 80;
  y0 -= 50;
  y1 += 70;
  const k = Math.max(0.08, Math.min(1.2, size.w / (x1 - x0), size.h / (y1 - y0)));
  const tx = size.w / 2 - ((x0 + x1) / 2) * k;
  const ty = size.h / 2 - ((y0 + y1) / 2) * k;
  if (animate) animateTo(k, tx, ty);
  else Object.assign(view, { k, tx, ty });
}
function centreOf(s: Sel): Pos | null {
  if (s.type === 'node') return layout.value.byId.has(s.id) ? pos(s.id) : null;
  const e = layout.value.edges.find((x) => x.id === s.id);
  if (!e) return null;
  const a = pos(e.from);
  const b = pos(e.to);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
/** Pans (and zooms in a little when far out) so the picked thing is on screen. */
function reveal(s: Sel, force = false) {
  const p = centreOf(s);
  if (!p) return;
  const sx = p.x * view.k + view.tx;
  const sy = p.y * view.k + view.ty;
  const m = 70;
  if (!force && sx > m && sx < size.w - m && sy > m && sy < size.h - m) return;
  const k = Math.max(view.k, force ? 0.9 : view.k);
  animateTo(k, size.w / 2 - p.x * k, size.h / 2 - p.y * k);
}

function onWheel(e: WheelEvent) {
  // The Overview's copy sits in a scrolling page: only ⌘/Ctrl + wheel and pinches zoom it.
  if (props.compact && !e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const r = svg.value!.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
}
function zoomBy(f: number) {
  zoomAt(size.w / 2, size.h / 2, f);
}

// ── Pointers: pan the background, drag nodes, pinch ─────────────────────────────────────
type Drag =
  | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number; moved: boolean }
  | { kind: 'node'; id: string; dx: number; dy: number; sx: number; sy: number; moved: boolean };
const drag = ref<Drag | null>(null);
const pointers = new Map<number, Pos>();
let pinch: { d: number; k: number } | null = null;
function toWorld(cx: number, cy: number): Pos {
  const r = svg.value!.getBoundingClientRect();
  return { x: (cx - r.left - view.tx) / view.k, y: (cy - r.top - view.ty) / view.k };
}
function onBackgroundDown(e: PointerEvent) {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, k: view.k };
    drag.value = null;
    return;
  }
  drag.value = {
    kind: 'pan',
    sx: e.clientX,
    sy: e.clientY,
    tx: view.tx,
    ty: view.ty,
    moved: false,
  };
  svg.value?.setPointerCapture?.(e.pointerId);
}
function onNodeDown(e: PointerEvent, id: string) {
  if (e.button !== 0) return;
  e.stopPropagation();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const w = toWorld(e.clientX, e.clientY);
  const p = pos(id);
  drag.value = {
    kind: 'node',
    id,
    dx: p.x - w.x,
    dy: p.y - w.y,
    sx: e.clientX,
    sy: e.clientY,
    moved: false,
  };
  svg.value?.setPointerCapture?.(e.pointerId);
}
function onMove(e: PointerEvent) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const r = svg.value!.getBoundingClientRect();
    const f = (pinch.k * (Math.hypot(a!.x - b!.x, a!.y - b!.y) / pinch.d)) / view.k;
    zoomAt((a!.x + b!.x) / 2 - r.left, (a!.y + b!.y) / 2 - r.top, f);
    return;
  }
  const d = drag.value;
  if (!d) return;
  const far = Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4;
  if (d.kind === 'pan') {
    if (far) d.moved = true;
    view.tx = d.tx + e.clientX - d.sx;
    view.ty = d.ty + e.clientY - d.sy;
  } else if (!props.compact && (far || d.moved)) {
    d.moved = true;
    hover.value = null;
    const w = toWorld(e.clientX, e.clientY);
    moved[d.id] = { x: Math.round(w.x + d.dx), y: Math.round(w.y + d.dy) };
  }
}
function onUp(e: PointerEvent) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  const d = drag.value;
  drag.value = null;
  if (!d) return;
  if (d.kind === 'pan' && !d.moved) selected.value = null;
  if (d.kind === 'node') {
    if (d.moved) onMoved();
    else activate(d.id);
  }
}

function activate(id: string) {
  const n = layout.value.byId.get(id);
  if (!n) return;
  hover.value = null;
  if (props.compact) {
    let c: MapNode | undefined = n;
    while (c && c.type !== 'device') c = c.parent ? layout.value.byId.get(c.parent) : undefined;
    void router.push({ name: 'network-map', query: c?.device ? { focus: c.device.id } : {} });
    return;
  }
  selected.value =
    selected.value?.type === 'node' && selected.value.id === id ? null : { type: 'node', id };
}
function pickLink(id: string) {
  if (props.compact) return;
  selected.value =
    selected.value?.type === 'link' && selected.value.id === id ? null : { type: 'link', id };
}
// The panel takes room from the canvas: once it has, bring the picked thing into view.
watch(selected, (s) => {
  if (!s) return;
  void nextTick(() => requestAnimationFrame(() => (measure(), reveal(s))));
});

// ── The Map tab's `?focus=<deviceId>` ─────────────────────────────────────────────────
let focused: string | undefined;
function applyFocus() {
  if (!props.focus || props.focus === focused || !measured) return;
  const id = deviceNodeId(props.focus);
  if (!layout.value.byId.has(id)) return;
  focused = props.focus;
  if (props.compact) return;
  selected.value = { type: 'node', id };
  void nextTick(() => requestAnimationFrame(() => (measure(), reveal({ type: 'node', id }, true))));
}
watch(() => [props.focus, layout.value], applyFocus);

// ── Search ───────────────────────────────────────────────────────────────────────────────
const query = ref('');
const searchOpen = ref(false);
const active = ref(0);
const hits = computed(() => searchMap(props.data, query.value));
watch(query, (q) => {
  active.value = 0;
  searchOpen.value = !!q.trim();
});
function pickHit(h: SearchHit | undefined) {
  if (!h) return;
  query.value = h.label;
  searchOpen.value = false;
  if (h.expand) {
    layers.endpoints = true;
    expanded.value = new Set([...expanded.value, h.expand]);
  }
  void nextTick(() => {
    if (!layout.value.byId.has(h.nodeId)) return;
    selected.value = { type: 'node', id: h.nodeId };
    void nextTick(() => requestAnimationFrame(() => (measure(), reveal(selected.value!, true))));
  });
}
function onSearchKey(e: KeyboardEvent) {
  const n = hits.value.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!n) return;
    e.preventDefault();
    searchOpen.value = true;
    active.value = (active.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pickHit(hits.value[active.value]);
  }
}

// ── Hover tooltip ───────────────────────────────────────────────────────────────────────
const tip = computed(() => {
  const id = hover.value;
  const n = id ? layout.value.byId.get(id) : undefined;
  if (!n || drag.value) return null;
  const p = pos(n.id);
  const x = Math.min(Math.max(p.x * view.k + view.tx, 110), size.w - 110);
  const y = p.y * view.k + view.ty - RADIUS[n.type] * view.k - 10;
  const lines: string[] = [];
  const d = n.device;
  if (d) {
    if (d.cpu != null || d.memory != null)
      lines.push(
        `${t('netMap.facts.cpu')} ${pct(d.cpu)} · ${t('netMap.facts.memory')} ${pct(d.memory)}`,
      );
    else if (d.portsTotal != null)
      lines.push(
        `${t('netMap.facts.ports')} ${t('netMap.facts.portsValue', { up: d.portsUp ?? 0, total: d.portsTotal })}`,
      );
  } else if (n.host) lines.push(n.host.cluster);
  else if (n.endpoint) lines.push([n.endpoint.mac, n.endpoint.vendor].filter(Boolean).join(' · '));
  return {
    x,
    y,
    below: y < 70,
    yBelow: p.y * view.k + view.ty + RADIUS[n.type] * view.k + 10,
    name: nodeName(n),
    sub: d ? [d.vendor, d.model].filter(Boolean).join(' ') : n.type === 'host' ? kindText(n) : '',
    status: statusText(n),
    tone: n.tone,
    lines,
  };
});

// ── The details panel ───────────────────────────────────────────────────────────────────
const hostRoute = (h: {
  kind: 'kubernetes' | 'server';
  name: string;
  clusterId: string;
}): RouteLocationRaw =>
  h.kind === 'kubernetes'
    ? { name: 'node', params: { name: h.name }, query: { cluster: h.clusterId } }
    : { name: 'server', params: { server: h.name }, query: { cluster: h.clusterId } };

const devicePanel = computed(() => {
  const d = selNode.value?.device;
  if (!d) return null;
  const problems = props.data.links
    .filter((l) => l.state !== 'ok' && (l.a.deviceId === d.id || l.b.deviceId === d.id))
    .map((l) => {
      const mine = l.a.deviceId === d.id ? l.a : l.b;
      const other = l.a.deviceId === d.id ? l.b : l.a;
      return {
        id: `l:${l.id}`,
        port: mine.port,
        other: `${devName.value.get(other.deviceId) ?? ''} ${other.port}`,
        tone: linkTone(l),
        text:
          l.state === 'down'
            ? t('netMap.link.state.down')
            : `${pct(l.utilisation)}${l.errors ? ` · ${t('netMap.link.errors')}` : ''}`,
      };
    });
  const behind = props.data.endpoints.filter((e) => e.deviceId === d.id);
  const hosts = new Map<string, NonNullable<Endpoint['node']>>();
  const vendors = new Map<string, number>();
  let others = 0;
  for (const e of behind) {
    if (e.node) hosts.set(`${e.node.kind}:${e.node.clusterId}:${e.node.name}`, e.node);
    else {
      others++;
      const v = e.vendor || '?';
      vendors.set(v, (vendors.get(v) ?? 0) + 1);
    }
  }
  const list = [...hosts.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    d,
    problems,
    servers: list.filter((h) => h.kind === 'server'),
    nodes: list.filter((h) => h.kind === 'kubernetes'),
    others,
    vendors: [...vendors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    empty: behind.length === 0,
  };
});

const linkPanel = computed(() => {
  const l = selEdge.value?.link;
  if (!l) return null;
  const a = devName.value.get(l.a.deviceId) ?? '';
  const b = devName.value.get(l.b.deviceId) ?? '';
  return {
    l,
    a,
    b,
    tone: linkTone(l),
    via: l.via
      .map((v) => (['cdp', 'lldp', 'mndp', 'mac'].includes(v) ? t(`netMap.via.${v}`) : v))
      .join(', '),
  };
});

const PILL: Record<Tone, string> = {
  ok: 'border-ok text-ok-text',
  warning: 'border-warning text-warning-text',
  critical: 'border-critical text-critical-text',
  neutral: 'border-border-strong text-text-muted',
};
const linkToneAsTone = (x: 'ok' | 'warning' | 'critical'): Tone => x;

// ── Size and first fit ─────────────────────────────────────────────────────────────────
let resize: ResizeObserver | undefined;
let measured = false;
function measure() {
  const r = box.value?.getBoundingClientRect();
  if (!r || r.width === 0) return;
  size.w = r.width;
  size.h = r.height;
  if (!measured) {
    measured = true;
    fit(false);
    applyFocus();
  }
}
onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && box.value) {
    resize = new ResizeObserver(() => measure());
    resize.observe(box.value);
  }
});
onBeforeUnmount(() => {
  resize?.disconnect();
  cancelAnimationFrame(anim);
  clearTimeout(saveTimer);
});
// The endpoints layer adds or removes rows: refit. Data refreshes keep the view.
watch(
  () => layers.endpoints,
  () => void nextTick(() => fit()),
);
/** Shows a device's unknown endpoints one by one, and keeps that device picked. */
function expand(deviceId: string) {
  layers.endpoints = true;
  expanded.value = new Set([...expanded.value, deviceId]);
  selected.value = { type: 'node', id: deviceNodeId(deviceId) };
}
</script>

<template>
  <section
    class="flex flex-col overflow-hidden rounded-card border border-border bg-surface-1"
    :aria-label="$t('netMap.label')"
    data-testid="network-map"
  >
    <!-- Search and layers: above the canvas, so they never cover a node. -->
    <div
      v-if="!compact"
      class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2.5"
    >
      <div
        class="relative w-full sm:max-w-xs"
        data-testid="map-search"
        @keydown="onSearchKey"
        @focusout="searchOpen = false"
        @focusin="searchOpen = !!query.trim()"
      >
        <SearchField
          v-model="query"
          :label="$t('netMap.search.label')"
          :placeholder="$t('netMap.search.placeholder')"
          @clear="query = ''"
        />
        <ul
          v-if="searchOpen && query.trim()"
          role="listbox"
          :aria-label="$t('netMap.search.label')"
          class="absolute inset-x-0 top-[calc(100%+4px)] z-20 flex flex-col rounded-control border border-border-strong bg-surface-2 p-1 shadow-menu"
          data-testid="map-search-results"
        >
          <li
            v-for="(h, i) in hits"
            :key="h.nodeId"
            role="option"
            :aria-selected="i === active"
            class="flex cursor-pointer items-center justify-between gap-2 rounded-control px-2 py-1.5 text-13 text-text max-lg:min-h-11"
            :class="i === active ? 'bg-surface-3' : 'hover:bg-surface-3'"
            @mousedown.prevent="pickHit(h)"
          >
            <span class="min-w-0 truncate font-mono">{{ h.label }}</span>
            <span class="shrink-0 truncate text-12 text-text-subtle">
              {{ $t(`netMap.search.kind.${h.kind}`) }} · {{ h.detail }}
            </span>
          </li>
          <li v-if="!hits.length" class="px-2 py-1.5 text-13 text-text-subtle">
            {{ $t('netMap.search.none') }}
          </li>
        </ul>
      </div>
      <div
        role="group"
        :aria-label="$t('netMap.layers.title')"
        class="flex flex-wrap items-center gap-1"
      >
        <span class="mr-1 font-mono text-11 tracking-wider text-text-subtle uppercase">{{
          $t('netMap.layers.title')
        }}</span>
        <button
          v-for="k in ['utilisation', 'endpoints'] as const"
          :key="k"
          type="button"
          class="inline-flex h-8 items-center gap-2 rounded-control px-2 text-13 text-text hover:bg-surface-2 max-lg:h-11"
          :aria-pressed="layers[k]"
          :data-testid="`map-layer-${k}`"
          @click="layers[k] = !layers[k]"
        >
          <span
            class="flex size-4 items-center justify-center rounded-[4px] border"
            :class="
              layers[k] ? 'border-primary bg-primary text-on-primary' : 'border-border-strong'
            "
            aria-hidden="true"
            ><svg
              v-if="layers[k]"
              viewBox="0 0 16 16"
              class="size-3"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
            >
              <path d="M3.5 8.5l3 3 6-7" /></svg
          ></span>
          {{ $t(`netMap.layers.${k}`) }}
        </button>
        <button
          type="button"
          disabled
          class="inline-flex h-8 cursor-not-allowed items-center gap-2 rounded-control px-2 text-13 text-text-subtle max-lg:h-11"
          aria-pressed="false"
          data-testid="map-layer-iscsi"
        >
          <span class="size-4 rounded-[4px] border border-border" aria-hidden="true" />
          {{ $t('netMap.layers.iscsi') }}
          <span class="text-12">· {{ $t('netMap.layers.nextRelease') }}</span>
        </button>
      </div>
      <p
        v-if="saveState !== 'idle'"
        class="text-12 sm:ml-auto"
        :class="saveState === 'error' ? 'text-critical-text' : 'text-text-muted'"
        role="status"
        data-testid="map-save-state"
      >
        {{
          saveState === 'saved'
            ? $t('netMap.layout.saved')
            : saveState === 'error'
              ? $t('netMap.layout.saveError')
              : $t('netMap.layout.notSaved')
        }}
      </p>
    </div>

    <div
      class="flex max-md:flex-col"
      :class="compact ? 'h-[360px]' : 'md:h-[clamp(480px,calc(100dvh_-_260px),960px)]'"
    >
      <!-- Nodes and links scale with the zoom (pinch on touch screens), so they are exempt
           from the 44 px touch-target check. -->
      <div
        ref="box"
        class="map-bg relative min-h-0 min-w-0 flex-1 overflow-hidden bg-bg outline-none"
        :class="compact ? '' : 'max-md:h-[60dvh] max-md:min-h-[360px] max-md:flex-none'"
        data-testid="map-canvas"
        data-layout-exempt="touch-target"
        @keydown.esc="selected = null"
      >
        <svg
          ref="svg"
          class="block h-full w-full touch-none select-none"
          :class="drag?.kind === 'pan' && drag.moved ? 'cursor-grabbing' : 'cursor-grab'"
          role="group"
          :aria-label="$t('netMap.label')"
          :data-motion="motion"
          @wheel="onWheel"
          @pointerdown="onBackgroundDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
        >
          <g :transform="`translate(${view.tx} ${view.ty}) scale(${view.k})`">
            <g data-layer="links">
              <g
                v-for="d in drawEdges"
                :key="d.e.id"
                v-memo="[
                  d.e,
                  d.x1,
                  d.y1,
                  d.x2,
                  d.y2,
                  d.faded,
                  d.selected,
                  d.flow?.dur,
                  d.flow?.dir,
                ]"
                :class="{ 'faded-link': d.faded }"
                :data-testid="d.e.link ? 'map-link' : d.e.down ? 'map-attach' : undefined"
                :data-link="d.e.link?.id"
                :data-state="d.e.link?.state ?? (d.e.down ? 'down' : undefined)"
              >
                <line
                  v-if="d.selected"
                  :x1="d.x1"
                  :y1="d.y1"
                  :x2="d.x2"
                  :y2="d.y2"
                  class="edge-selected"
                  :stroke-width="d.width + 6"
                />
                <line
                  :x1="d.x1"
                  :y1="d.y1"
                  :x2="d.x2"
                  :y2="d.y2"
                  class="edge"
                  :class="`edge-${d.tone}`"
                  :stroke-width="d.width"
                />
                <line
                  v-if="d.flow"
                  :x1="d.x1"
                  :y1="d.y1"
                  :x2="d.x2"
                  :y2="d.y2"
                  class="flow"
                  :class="[`flow-${d.tone}`, { rev: d.flow.dir < 0 }]"
                  :stroke-width="Math.max(1.2, d.width - 0.5)"
                  :style="{ animationDuration: `${d.flow.dur}s` }"
                />
                <line
                  v-if="d.e.link && !compact"
                  :x1="d.x1"
                  :y1="d.y1"
                  :x2="d.x2"
                  :y2="d.y2"
                  class="edge-hit"
                  role="button"
                  tabindex="0"
                  :aria-label="linkAria(d.e)"
                  :aria-pressed="d.selected"
                  @pointerdown.stop
                  @click.stop="pickLink(d.e.id)"
                  @keydown.enter.prevent="pickLink(d.e.id)"
                  @keydown.space.prevent="pickLink(d.e.id)"
                />
              </g>
            </g>
            <g data-layer="link-labels" aria-hidden="true">
              <template v-for="d in drawEdges" :key="d.e.id">
                <g
                  v-if="d.label"
                  :class="{ 'faded-link': d.faded }"
                  :transform="`translate(${(d.x1 + d.x2) / 2} ${(d.y1 + d.y2) / 2})`"
                  class="pointer-events-none"
                >
                  <rect
                    :x="-(d.label.length * 3.6 + 7)"
                    y="-10"
                    :width="d.label.length * 7.2 + 14"
                    height="20"
                    rx="5"
                    class="label-bg"
                    :class="`label-${d.tone}`"
                  />
                  <text y="4" text-anchor="middle" class="label-text" :class="`label-${d.tone}`">
                    {{ d.label }}
                  </text>
                </g>
              </template>
            </g>
            <g data-layer="nodes">
              <g
                v-for="d in drawNodes"
                :key="d.n.id"
                v-memo="[d.x, d.y, d.faded, d.selected, d.name, d.sub, d.n]"
                class="map-node cursor-pointer outline-none"
                :class="{ 'faded-node': d.faded }"
                :transform="`translate(${d.x} ${d.y})`"
                role="button"
                tabindex="0"
                :aria-label="nodeAria(d.n)"
                :aria-pressed="d.selected"
                data-testid="map-node"
                :data-node="d.n.id"
                :data-type="d.n.type"
                :data-tone="d.n.tone"
                @pointerdown="onNodeDown($event, d.n.id)"
                @keydown.enter.prevent="activate(d.n.id)"
                @keydown.space.prevent="activate(d.n.id)"
                @mouseenter="hover = d.n.id"
                @mouseleave="hover = null"
                @focus="hover = d.n.id"
                @blur="hover = null"
              >
                <template v-if="d.n.type === 'group'">
                  <rect
                    v-if="d.selected"
                    x="-50"
                    y="-22"
                    width="100"
                    height="44"
                    rx="22"
                    class="sel-ring"
                  />
                  <rect x="-44" y="-16" width="88" height="32" rx="16" class="group-body" />
                  <text y="4.5" text-anchor="middle" class="group-text">
                    {{ nodeName(d.n) }}
                  </text>
                </template>
                <template v-else>
                  <circle
                    v-if="d.n.tone === 'warning' || d.n.tone === 'critical'"
                    :r="d.r + 5"
                    class="halo"
                    :class="`stroke-${d.n.tone}`"
                  />
                  <circle v-if="d.selected" :r="d.r + 9" class="sel-ring" />
                  <circle :r="d.r" class="node-body" :class="`ring-${d.n.tone}`" />
                  <g
                    :class="
                      d.n.tone === 'ok' || d.n.tone === 'neutral'
                        ? 'text-text-muted'
                        : TONE_TEXT[d.n.tone]
                    "
                  >
                    <KindIcon
                      :kind="d.n.kind"
                      :x="d.n.type === 'endpoint' ? -7 : -11"
                      :y="d.n.type === 'endpoint' ? -7 : -11"
                      :size="d.n.type === 'endpoint' ? 14 : 22"
                    />
                  </g>
                  <g v-if="d.n.alerts > 0" transform="translate(14 -34)" aria-hidden="true">
                    <rect
                      :width="String(d.n.alerts).length * 7 + 12"
                      height="18"
                      rx="9"
                      class="badge-bg"
                      :class="`stroke-${d.n.tone === 'critical' ? 'critical' : 'warning'}`"
                    />
                    <text
                      :x="(String(d.n.alerts).length * 7 + 12) / 2"
                      y="13"
                      text-anchor="middle"
                      class="badge-text"
                      :class="d.n.tone === 'critical' ? 'fill-critical-text' : 'fill-warning-text'"
                    >
                      {{ d.n.alerts }}
                    </text>
                  </g>
                  <g
                    v-if="d.n.type === 'device' && d.n.behind > 0"
                    transform="translate(14 16)"
                    aria-hidden="true"
                  >
                    <rect
                      :width="String(d.n.behind).length * 7 + 12"
                      height="18"
                      rx="9"
                      class="badge-bg stroke-strong"
                    />
                    <text
                      :x="(String(d.n.behind).length * 7 + 12) / 2"
                      y="13"
                      text-anchor="middle"
                      class="badge-text fill-text"
                    >
                      {{ d.n.behind }}
                    </text>
                  </g>
                  <text v-if="d.name" :y="d.r + 17" text-anchor="middle" class="node-label">
                    {{ nodeName(d.n) }}
                  </text>
                  <text v-if="d.sub" :y="d.r + 32" text-anchor="middle" class="node-sub">
                    {{ d.n.sub }}
                  </text>
                </template>
              </g>
            </g>
          </g>
        </svg>

        <!-- Band names stay at the left edge while the map pans. -->
        <span
          v-for="b in layout.bands"
          v-show="b.y * view.k + view.ty > 8 && b.y * view.k + view.ty < size.h - 8"
          :key="b.band"
          class="pointer-events-none absolute left-3 -translate-y-1/2 font-mono text-11 tracking-wider text-text-subtle uppercase"
          :style="{ top: `${b.y * view.k + view.ty}px` }"
          aria-hidden="true"
          >{{ $t(`netMap.bands.${b.band}`) }}</span
        >

        <div
          v-if="tip"
          class="pointer-events-none absolute z-10 flex max-w-[220px] -translate-x-1/2 flex-col gap-0.5 rounded-control border border-border-strong bg-surface-2 px-2.5 py-1.5 text-12 shadow-menu"
          :class="tip.below ? '' : '-translate-y-full'"
          :style="{ left: `${tip.x}px`, top: `${tip.below ? tip.yBelow : tip.y}px` }"
          role="tooltip"
          data-testid="map-tooltip"
        >
          <span class="truncate font-mono text-13 text-text">{{ tip.name }}</span>
          <span v-if="tip.sub" class="truncate text-text-muted">{{ tip.sub }}</span>
          <span v-if="tip.status" :class="TONE_TEXT[tip.tone]">{{ tip.status }}</span>
          <span v-for="(line, i) in tip.lines" :key="i" class="tabular text-text-muted">{{
            line
          }}</span>
        </div>

        <div class="absolute top-2.5 right-2.5 flex flex-col gap-1">
          <button
            v-for="b in [
              { key: 'in', icon: Plus, run: () => zoomBy(1.25) },
              { key: 'out', icon: Minus, run: () => zoomBy(0.8) },
              { key: 'fit', icon: Maximize, run: () => fit() },
            ]"
            :key="b.key"
            type="button"
            class="flex size-8 items-center justify-center rounded-control border border-border-strong bg-surface-2 text-text-muted hover:text-text max-lg:size-11"
            data-layout-exempt="none"
            :aria-label="$t(`netMap.tools.${b.key}`)"
            :title="$t(`netMap.tools.${b.key}`)"
            :data-testid="`map-${b.key === 'in' ? 'zoom-in' : b.key === 'out' ? 'zoom-out' : 'fit'}`"
            @click="b.run"
          >
            <component :is="b.icon" class="size-4" aria-hidden="true" />
          </button>
          <button
            v-if="!compact && auth.canManage && customised"
            type="button"
            class="flex size-8 items-center justify-center rounded-control border border-border-strong bg-surface-2 text-text-muted hover:text-text max-lg:size-11"
            data-layout-exempt="none"
            :aria-label="$t('netMap.tools.reset')"
            :title="$t('netMap.tools.reset')"
            data-testid="map-reset"
            @click="resetLayout"
          >
            <RotateCcw class="size-4" aria-hidden="true" />
          </button>
        </div>

        <div
          v-if="!compact"
          class="pointer-events-none absolute bottom-2.5 left-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 rounded-control border border-border bg-surface-1 px-3 py-1.5 text-12 text-text-muted max-md:hidden"
          data-testid="map-legend"
        >
          <span class="flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="18" y2="3" class="edge edge-ok" stroke-width="3" />
            </svg>
            {{ $t('netMap.legend.speed') }}
          </span>
          <span class="flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="18" y2="3" class="flow flow-ok" stroke-width="3" />
            </svg>
            {{ $t('netMap.legend.traffic') }}
          </span>
          <span class="flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="18" y2="3" class="edge edge-warning" stroke-width="3" />
            </svg>
            {{ $t('netMap.legend.busy') }}
          </span>
          <span class="flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="18" y2="3" class="edge edge-critical" stroke-width="3" />
            </svg>
            {{ $t('netMap.legend.down') }}
          </span>
          <span class="max-lg:hidden">{{ $t('netMap.legend.hint') }}</span>
        </div>
      </div>

      <aside
        v-if="!compact && (selNode || linkPanel)"
        class="flex w-[340px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface-1 p-4 max-md:w-full max-md:border-t max-md:border-l-0"
        :aria-label="
          selNode ? nodeName(selNode) : linkPanel ? `${linkPanel.a} ↔ ${linkPanel.b}` : ''
        "
        data-testid="map-panel"
        @keydown.esc="selected = null"
      >
        <!-- A device, a server or node, a group or one endpoint. -->
        <template v-if="selNode">
          <div class="flex items-start gap-3">
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-full border-2 bg-surface-3"
              :class="[PILL[selNode.tone]]"
            >
              <KindIcon
                :kind="selNode.type === 'group' ? 'endpoint' : selNode.kind"
                class="size-5"
              />
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="truncate font-mono text-14 text-text" data-testid="map-panel-title">{{
                selNode.type === 'group'
                  ? $t('netMap.panel.endpointsOn', {
                      device: devName.get(selNode.group!.deviceId) ?? '',
                    })
                  : nodeName(selNode)
              }}</span>
              <span class="truncate text-12 text-text-muted">
                {{ kindText(selNode) }}{{ selNode.device?.model ? ` · ${selNode.device.model}` : ''
                }}{{ selNode.host ? ` · ${selNode.host.cluster}` : '' }}
              </span>
            </span>
            <button
              type="button"
              class="flex size-8 shrink-0 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text max-lg:size-11"
              :aria-label="$t('netMap.panel.close')"
              data-testid="map-panel-close"
              @click="selected = null"
            >
              <X class="size-4" aria-hidden="true" />
            </button>
          </div>

          <template v-if="devicePanel">
            <span
              class="inline-flex h-6 items-center self-start rounded-full border px-2.5 text-12 font-semibold"
              :class="PILL[selNode.tone]"
              >{{ statusText(selNode) }}</span
            >
            <p v-if="devicePanel.d.error" class="text-13 text-critical-text">
              {{ devicePanel.d.error }}
            </p>
            <div class="grid grid-cols-2 gap-2">
              <span
                v-for="f in [
                  { k: 'cpu', v: pct(devicePanel.d.cpu) },
                  { k: 'memory', v: pct(devicePanel.d.memory) },
                  {
                    k: 'ports',
                    v:
                      devicePanel.d.portsTotal != null
                        ? $t('netMap.facts.portsValue', {
                            up: devicePanel.d.portsUp ?? 0,
                            total: devicePanel.d.portsTotal,
                          })
                        : '–',
                  },
                  { k: 'uptime', v: uptimeText(devicePanel.d.uptimeS) },
                ]"
                :key="f.k"
                class="flex flex-col gap-0.5 rounded-control bg-surface-2 px-2.5 py-2"
              >
                <span class="text-12 text-text-muted">{{ $t(`netMap.facts.${f.k}`) }}</span>
                <span class="font-mono text-14 text-text tabular">{{ f.v }}</span>
              </span>
            </div>
            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-13">
              <template
                v-for="f in [
                  { k: 'address', v: devicePanel.d.address },
                  {
                    k: 'model',
                    v: [devicePanel.d.vendor, devicePanel.d.model].filter(Boolean).join(' '),
                  },
                  { k: 'firmware', v: devicePanel.d.firmware },
                  {
                    k: 'poller',
                    v: devicePanel.d.poller.host
                      ? `${devicePanel.d.poller.name} · ${devicePanel.d.poller.host}`
                      : devicePanel.d.poller.name,
                  },
                  {
                    k: 'protocol',
                    v: devicePanel.d.protocol === 'routeros' ? 'RouterOS API' : 'SNMP',
                  },
                ]"
                :key="f.k"
              >
                <dt class="text-text-muted">{{ $t(`netMap.facts.${f.k}`) }}</dt>
                <dd class="min-w-0 truncate font-mono text-text">{{ f.v || '–' }}</dd>
              </template>
            </dl>

            <section class="flex flex-col gap-1.5">
              <h3 class="font-mono text-11 tracking-wider text-text-subtle uppercase">
                {{ $t('netMap.panel.problems') }}
              </h3>
              <p v-if="!devicePanel.problems.length" class="text-13 text-text-muted">
                {{ $t('netMap.panel.noProblems') }}
              </p>
              <button
                v-for="p in devicePanel.problems"
                :key="p.id"
                type="button"
                class="flex items-center justify-between gap-2 rounded-control bg-surface-2 px-2.5 py-1.5 text-left text-13 hover:bg-surface-3 max-lg:min-h-11"
                data-testid="map-panel-problem"
                @click="pickLink(p.id)"
              >
                <span class="min-w-0 truncate font-mono text-text"
                  >{{ p.port }} → {{ p.other }}</span
                >
                <span class="shrink-0" :class="TONE_TEXT[linkToneAsTone(p.tone)]">{{
                  p.text
                }}</span>
              </button>
            </section>

            <section class="flex flex-col gap-1.5">
              <h3 class="font-mono text-11 tracking-wider text-text-subtle uppercase">
                {{ $t('netMap.panel.behind') }}
              </h3>
              <p v-if="devicePanel.empty" class="text-13 text-text-muted">
                {{ $t('netMap.panel.nothingBehind') }}
              </p>
              <template v-for="g in ['servers', 'nodes'] as const" :key="g">
                <div v-if="devicePanel[g].length" class="flex flex-col gap-1">
                  <span class="text-12 text-text-muted"
                    >{{ $t(`netMap.panel.${g}`) }} · {{ devicePanel[g].length }}</span
                  >
                  <div class="flex flex-wrap gap-1.5">
                    <RouterLink
                      v-for="h in devicePanel[g].slice(0, 12)"
                      :key="h.name"
                      :to="hostRoute(h)"
                      class="inline-flex items-center rounded-control bg-surface-2 px-2 py-0.5 font-mono text-12 text-link hover:bg-surface-3 max-lg:min-h-11 max-lg:min-w-11 max-lg:px-3"
                      >{{ h.name }}</RouterLink
                    >
                    <span v-if="devicePanel[g].length > 12" class="px-1 text-12 text-text-muted">
                      {{ $t('netMap.panel.andMore', { n: devicePanel[g].length - 12 }) }}
                    </span>
                  </div>
                </div>
              </template>
              <div v-if="devicePanel.others" class="flex flex-col gap-1">
                <span class="text-12 text-text-muted"
                  >{{ $t('netMap.panel.others') }} · {{ devicePanel.others }}</span
                >
                <span class="text-13 text-text">
                  {{
                    devicePanel.vendors
                      .map(([v, n]) => $t('netMap.panel.byVendor', { vendor: v, n }))
                      .join(', ')
                  }}
                </span>
                <button
                  v-if="!layers.endpoints || !expanded.has(devicePanel.d.id)"
                  type="button"
                  class="inline-flex items-center self-start text-13 font-medium text-link hover:underline max-lg:min-h-11"
                  data-testid="map-panel-show-endpoints"
                  @click="expand(devicePanel.d.id)"
                >
                  {{ $t('netMap.panel.showAll') }}
                </button>
              </div>
            </section>

            <div class="flex flex-wrap gap-2">
              <RouterLink
                :to="{ name: 'network-device', params: { id: devicePanel.d.id } }"
                class="inline-flex h-9 items-center rounded-control bg-primary px-3.5 text-13 font-semibold text-on-primary hover:bg-primary-hover max-lg:h-11"
                data-testid="map-panel-open"
                >{{ $t('netMap.panel.openDevice') }}</RouterLink
              >
            </div>
          </template>

          <template v-else-if="selNode.host">
            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-13">
              <dt class="text-text-muted">{{ $t('netMap.facts.cluster') }}</dt>
              <dd class="min-w-0 truncate text-text">{{ selNode.host.cluster }}</dd>
            </dl>
            <section class="flex flex-col gap-1.5">
              <h3 class="font-mono text-11 tracking-wider text-text-subtle uppercase">
                {{ $t('netMap.facts.connectedTo') }}
              </h3>
              <div
                v-for="e in selNode.host.endpoints"
                :key="e.mac + e.deviceId + e.port"
                class="flex flex-col rounded-control bg-surface-2 px-2.5 py-1.5 text-13"
              >
                <span class="font-mono text-text"
                  >{{ devName.get(e.deviceId) }} · {{ e.port }}</span
                >
                <span class="font-mono text-12 text-text-muted">{{
                  [e.ip, e.mac].filter(Boolean).join(' · ')
                }}</span>
              </div>
            </section>
            <div class="flex flex-wrap gap-2">
              <RouterLink
                :to="hostRoute(selNode.host)"
                class="inline-flex h-9 items-center rounded-control bg-primary px-3.5 text-13 font-semibold text-on-primary hover:bg-primary-hover max-lg:h-11"
                data-testid="map-panel-open"
                >{{
                  selNode.host.kind === 'kubernetes'
                    ? $t('netMap.panel.openNode')
                    : $t('netMap.panel.openServer')
                }}</RouterLink
              >
            </div>
          </template>

          <template v-else-if="selNode.group">
            <ul class="flex flex-col gap-1">
              <li
                v-for="e in selNode.group.endpoints.slice(0, 40)"
                :key="e.mac"
                class="flex items-center justify-between gap-2 rounded-control bg-surface-2 px-2.5 py-1 text-13"
              >
                <span class="min-w-0 truncate font-mono text-text">{{ e.ip ?? e.mac }}</span>
                <span class="shrink-0 truncate text-12 text-text-muted"
                  >{{ e.vendor || e.mac }} · {{ e.port }}</span
                >
              </li>
            </ul>
            <p v-if="selNode.group.endpoints.length > 40" class="text-12 text-text-muted">
              {{ $t('netMap.panel.andMore', { n: selNode.group.endpoints.length - 40 }) }}
            </p>
            <button
              type="button"
              class="inline-flex items-center self-start text-13 font-medium text-link hover:underline max-lg:min-h-11"
              data-testid="map-panel-show-endpoints"
              @click="expand(selNode.group.deviceId)"
            >
              {{ $t('netMap.panel.showAll') }}
            </button>
          </template>

          <template v-else-if="selNode.endpoint">
            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-13">
              <template
                v-for="f in [
                  { k: 'ip', v: selNode.endpoint.ip },
                  { k: 'mac', v: selNode.endpoint.mac },
                  { k: 'vendor', v: selNode.endpoint.vendor },
                  {
                    k: 'connectedTo',
                    v: `${devName.get(selNode.endpoint.deviceId) ?? ''} · ${selNode.endpoint.port}`,
                  },
                ]"
                :key="f.k"
              >
                <dt class="text-text-muted">{{ $t(`netMap.facts.${f.k}`) }}</dt>
                <dd class="min-w-0 truncate font-mono text-text">{{ f.v || '–' }}</dd>
              </template>
            </dl>
          </template>

          <template v-else-if="selNode.type === 'internet'">
            <section class="flex flex-col gap-1.5">
              <h3 class="font-mono text-11 tracking-wider text-text-subtle uppercase">
                {{ $t('netMap.panel.gateways') }}
              </h3>
              <div
                v-for="d in data.devices.filter((x) => x.gateway)"
                :key="d.id"
                class="flex items-center justify-between gap-2 rounded-control bg-surface-2 px-2.5 py-1.5 text-13"
              >
                <span class="truncate font-mono text-text">{{ d.name }}</span>
                <span class="shrink-0 font-mono text-12 text-text-muted">{{ d.gateway }}</span>
              </div>
            </section>
          </template>
        </template>

        <!-- A link: both ends, speed, use both ways, errors, how it was learnt. -->
        <template v-else-if="linkPanel">
          <div class="flex items-start gap-3">
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="truncate font-mono text-14 text-text" data-testid="map-panel-title"
                >{{ linkPanel.a }} ↔ {{ linkPanel.b }}</span
              >
              <span class="truncate font-mono text-12 text-text-muted">
                {{ linkPanel.l.a.port }} ↔ {{ linkPanel.l.b.port }} ·
                {{ speedLong(linkPanel.l.speedMbps) }}
              </span>
            </span>
            <button
              type="button"
              class="flex size-8 shrink-0 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text max-lg:size-11"
              :aria-label="$t('netMap.panel.close')"
              data-testid="map-panel-close"
              @click="selected = null"
            >
              <X class="size-4" aria-hidden="true" />
            </button>
          </div>
          <span
            class="inline-flex h-6 items-center self-start rounded-full border px-2.5 text-12 font-semibold"
            :class="PILL[linkToneAsTone(linkPanel.tone)]"
            >{{ $t(`netMap.link.state.${linkPanel.l.state}`) }}</span
          >
          <div class="grid grid-cols-2 gap-2">
            <span
              v-for="f in [
                { k: 'use', l: $t('netMap.link.use'), v: pct(linkPanel.l.utilisation) },
                { k: 'speed', l: $t('netMap.link.speed'), v: speedLong(linkPanel.l.speedMbps) },
                { k: 'ab', l: `${linkPanel.a} → ${linkPanel.b}`, v: bpsText(linkPanel.l.bpsAB) },
                { k: 'ba', l: `${linkPanel.b} → ${linkPanel.a}`, v: bpsText(linkPanel.l.bpsBA) },
              ]"
              :key="f.k"
              class="flex min-w-0 flex-col gap-0.5 rounded-control bg-surface-2 px-2.5 py-2"
            >
              <span class="truncate text-12 text-text-muted">{{ f.l }}</span>
              <span
                class="font-mono text-14 tabular"
                :class="
                  f.k === 'use' && linkPanel.l.state !== 'ok'
                    ? TONE_TEXT[linkToneAsTone(linkPanel.tone)]
                    : 'text-text'
                "
                >{{ f.v }}</span
              >
            </span>
          </div>
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-13">
            <dt class="text-text-muted">{{ $t('netMap.link.errors') }}</dt>
            <dd :class="linkPanel.l.errors ? 'text-warning-text' : 'text-text'">
              {{
                linkPanel.l.errors ? $t('netMap.link.errorsRising') : $t('netMap.link.errorsNone')
              }}
            </dd>
            <dt class="text-text-muted">{{ $t('netMap.link.via') }}</dt>
            <dd class="text-text">{{ linkPanel.via || '–' }}</dd>
          </dl>
          <section class="flex flex-col gap-1.5">
            <h3 class="font-mono text-11 tracking-wider text-text-subtle uppercase">
              {{ $t('netMap.link.both') }}
            </h3>
            <RouterLink
              v-for="end in [linkPanel.l.a, linkPanel.l.b]"
              :key="end.deviceId + end.port"
              :to="{ name: 'network-device', params: { id: end.deviceId } }"
              class="flex items-center justify-between gap-2 rounded-control bg-surface-2 px-2.5 py-1.5 text-13 hover:bg-surface-3 max-lg:min-h-11"
              data-testid="map-panel-end"
            >
              <span class="truncate font-mono text-link">{{ devName.get(end.deviceId) }}</span>
              <span class="shrink-0 font-mono text-12 text-text-muted">{{ end.port }}</span>
            </RouterLink>
          </section>
        </template>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.map-bg {
  background-image: radial-gradient(var(--border) 1px, transparent 1px);
  background-size: 22px 22px;
}
.edge {
  fill: none;
  stroke-linecap: round;
}
.edge-ok {
  stroke: var(--info);
  stroke-opacity: 0.45;
}
.edge-warning {
  stroke: var(--warning);
}
.edge-critical {
  stroke: var(--critical);
  stroke-dasharray: 7 5;
  stroke-linecap: butt;
}
.edge-quiet {
  stroke: var(--border-strong);
}
.edge-selected {
  stroke: var(--text);
  stroke-opacity: 0.25;
  stroke-linecap: round;
}
/* Traffic: dashes that move under motion and stand still (still visible) without it. */
.flow {
  fill: none;
  stroke-dasharray: 6 10;
  animation: map-flow 1.5s linear infinite;
  animation-play-state: paused;
}
.flow-ok {
  stroke: var(--info);
}
.flow-warning {
  stroke: var(--warning-text);
}
[data-motion='on'] .flow {
  animation-play-state: running;
}
[data-motion='off'] .flow {
  animation: none;
}
.flow.rev {
  animation-direction: reverse;
}
@keyframes map-flow {
  to {
    stroke-dashoffset: -32;
  }
}
.edge-hit {
  stroke: transparent;
  stroke-width: 16;
  fill: none;
  cursor: pointer;
}
.edge-hit:focus-visible {
  stroke: var(--primary);
  stroke-opacity: 0.4;
  outline: none;
}
.label-bg {
  fill: var(--bg);
  stroke: var(--border);
}
.label-bg.label-warning {
  stroke: var(--warning);
}
.label-bg.label-critical {
  stroke: var(--critical);
}
.label-text {
  font-family: var(--font-mono);
  font-size: var(--text-12);
  fill: var(--text-muted);
}
.label-text.label-warning {
  fill: var(--warning-text);
}
.label-text.label-critical {
  fill: var(--critical-text);
}
.node-body {
  fill: var(--surface-2);
  stroke-width: 2;
}
.ring-ok {
  stroke: var(--ok);
}
.ring-warning {
  stroke: var(--warning);
}
.ring-critical {
  stroke: var(--critical);
}
.ring-neutral {
  stroke: var(--border-strong);
}
.halo {
  fill: none;
  stroke-width: 4;
  stroke-opacity: 0.3;
}
.stroke-warning {
  stroke: var(--warning);
}
.stroke-critical {
  stroke: var(--critical);
}
.stroke-strong {
  stroke: var(--border-strong);
}
.sel-ring {
  fill: none;
  stroke: var(--primary);
  stroke-width: 2.5;
}
.group-body {
  fill: var(--surface-2);
  stroke: var(--border-strong);
  stroke-dasharray: 4 3;
}
.group-text {
  font-family: var(--font-mono);
  font-size: var(--text-12);
  fill: var(--text);
}
.badge-bg {
  fill: var(--surface-3);
  stroke-width: 1;
}
.badge-text {
  font-family: var(--font-mono);
  font-size: var(--text-12);
  font-weight: 600;
}
.fill-text {
  fill: var(--text);
}
.fill-warning-text {
  fill: var(--warning-text);
}
.fill-critical-text {
  fill: var(--critical-text);
}
.node-label {
  font-family: var(--font-mono);
  font-size: var(--text-12);
  fill: var(--text);
  paint-order: stroke;
  stroke: var(--bg);
  stroke-width: 4px;
  stroke-linejoin: round;
  pointer-events: none;
}
.node-sub {
  font-size: var(--text-12);
  fill: var(--text-subtle);
  paint-order: stroke;
  stroke: var(--bg);
  stroke-width: 4px;
  stroke-linejoin: round;
  pointer-events: none;
}
.map-node:focus-visible .node-body,
.map-node:focus-visible .group-body {
  stroke: var(--primary);
  stroke-width: 3;
}
.map-node:hover .node-body {
  fill: var(--surface-3);
}
.faded-node {
  opacity: 0.28;
}
.faded-link {
  opacity: 0.18;
}
.map-node,
.faded-link {
  transition: opacity 0.2s;
}
@media (prefers-reduced-motion: reduce) {
  .map-node,
  .faded-link {
    transition: none;
  }
}
</style>
