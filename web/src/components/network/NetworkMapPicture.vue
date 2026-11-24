<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// A still picture of the network map (ADR-233), drawn from the Map board's layout with the
// product's colours, for the teaser: bands from the Internet down to the servers, a router,
// a core switch, two access switches, one link busy and one down. Nothing is loaded.
const nodes = [
  { x: 300, y: 34, r: 14, cls: 'fill-surface-2 stroke-border', label: 'Internet' },
  { x: 300, y: 104, r: 18, cls: 'fill-surface-1 stroke-ok', label: 'edge-1' },
  { x: 300, y: 180, r: 18, cls: 'fill-surface-1 stroke-ok', label: 'core-1' },
  { x: 170, y: 258, r: 18, cls: 'fill-surface-1 stroke-warning', label: 'sw-access-1' },
  { x: 430, y: 258, r: 18, cls: 'fill-surface-1 stroke-ok', label: 'sw-access-2' },
  { x: 100, y: 330, r: 11, cls: 'fill-surface-1 stroke-ok', label: 'web-1' },
  { x: 170, y: 330, r: 11, cls: 'fill-surface-1 stroke-critical', label: 'web-2' },
  { x: 240, y: 330, r: 11, cls: 'fill-surface-1 stroke-ok', label: 'nas-1' },
  { x: 380, y: 330, r: 11, cls: 'fill-surface-1 stroke-ok', label: 'db-1' },
  { x: 480, y: 330, r: 11, cls: 'fill-surface-1 stroke-ok', label: 'db-2' },
];
const links = [
  { a: 0, b: 1, w: 2, cls: 'stroke-border', dash: '' },
  { a: 1, b: 2, w: 4, cls: 'stroke-primary', dash: '6 6' },
  { a: 2, b: 3, w: 4, cls: 'stroke-warning', dash: '6 6' },
  { a: 2, b: 4, w: 4, cls: 'stroke-primary', dash: '6 6' },
  { a: 3, b: 5, w: 2, cls: 'stroke-border', dash: '' },
  { a: 3, b: 6, w: 2, cls: 'stroke-critical', dash: '4 4' },
  { a: 3, b: 7, w: 2, cls: 'stroke-border', dash: '' },
  { a: 4, b: 8, w: 2, cls: 'stroke-border', dash: '' },
  { a: 4, b: 9, w: 2, cls: 'stroke-border', dash: '' },
];
const bands = [
  { y: 12, label: 'Internet' },
  { y: 82, label: 'Edge' },
  { y: 158, label: 'Core' },
  { y: 236, label: 'Access' },
  { y: 310, label: 'Devices' },
];
</script>

<template>
  <svg
    viewBox="0 0 600 360"
    class="h-auto w-full rounded-xl border border-border bg-bg"
    role="img"
    :aria-label="$t('network.teaser.pictureAlt')"
    data-testid="network-teaser-picture"
  >
    <g v-for="(b, i) in bands" :key="b.label">
      <rect
        x="0"
        :y="b.y"
        width="600"
        height="44"
        :class="i % 2 ? 'fill-surface-1' : 'fill-bg'"
        opacity="0.6"
      />
      <text x="12" :y="b.y + 26" class="fill-text-subtle text-[11px]">{{ b.label }}</text>
    </g>
    <line
      v-for="(l, i) in links"
      :key="i"
      :x1="nodes[l.a]!.x"
      :y1="nodes[l.a]!.y"
      :x2="nodes[l.b]!.x"
      :y2="nodes[l.b]!.y"
      :class="l.cls"
      :stroke-width="l.w"
      :stroke-dasharray="l.dash || undefined"
      stroke-linecap="round"
    />
    <g v-for="n in nodes" :key="n.label">
      <circle :cx="n.x" :cy="n.y" :r="n.r" :class="n.cls" stroke-width="2.5" />
      <text
        :x="n.x"
        :y="n.y + n.r + 13"
        text-anchor="middle"
        class="fill-text-muted text-[10px] font-medium"
      >
        {{ n.label }}
      </text>
    </g>
  </svg>
</template>
