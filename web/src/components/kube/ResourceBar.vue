<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { exactCores, formatCores, resourceBar } from '@/lib/resources';
import { formatBytes } from '@/lib/units';

// Usage against request and limit (ADR-111): the value,
// "req X" or "no request", a bar with a tick at the request and a red marker at the
// limit; near the limit the value and bar turn red. The tooltip has the exact values.
const props = withDefaults(
  defineProps<{
    usage: number | null;
    request: number | null;
    limit: number | null;
    unit: 'cores' | 'bytes';
    /** "limit" for Docker, where the limit is the only reference. */
    reference?: 'request' | 'limit';
  }>(),
  { reference: 'request' },
);
const { t } = useI18n();
const fmt = (v: number) => (props.unit === 'cores' ? formatCores(v) : formatBytes(v));
const exact = (v: number) =>
  props.unit === 'cores' ? t('resources.cores', { v: exactCores(v) }) : formatBytes(v);
const bar = computed(() =>
  props.usage === null ? null : resourceBar(props.usage, props.request || null, props.limit),
);
const tip = computed(() =>
  props.usage === null
    ? t('resources.noData')
    : [
        t('resources.used', { v: exact(props.usage) }),
        ...(props.reference === 'request'
          ? [
              props.request
                ? t('resources.request', { v: exact(props.request) })
                : t('resources.noRequest'),
            ]
          : []),
        props.limit !== null
          ? t('resources.limit', { v: exact(props.limit) })
          : t('resources.noLimit'),
      ].join(' · '),
);
</script>

<template>
  <span v-if="!bar" class="text-text-subtle" :title="tip">–</span>
  <span
    v-else
    class="rb"
    role="img"
    :aria-label="tip"
    :title="tip"
    data-testid="resource-bar"
    :data-state="bar.near ? 'near' : 'ok'"
  >
    <span class="top">
      <span :class="bar.near && 'text-critical'">{{ fmt(usage!) }}</span>
      <span class="text-text-subtle">
        <template v-if="reference === 'limit'">{{
          limit !== null ? $t('resources.limitShort', { v: fmt(limit) }) : $t('resources.noLimit')
        }}</template>
        <template v-else>{{
          request ? $t('resources.reqShort', { v: fmt(request) }) : $t('resources.noRequest')
        }}</template>
      </span>
    </span>
    <span class="track">
      <span
        class="u"
        :class="bar.near ? 'bg-critical' : unit === 'cores' ? 'bg-info' : 'bg-violet'"
        :style="{ width: `${bar.usage}%` }"
      />
      <span
        v-if="bar.request !== null && reference === 'request'"
        class="rq"
        :style="{ left: `${bar.request}%` }"
        data-testid="request-tick"
      />
      <span
        v-if="bar.limit !== null"
        class="lm"
        :style="{ left: `calc(${bar.limit}% - 2px)` }"
        data-testid="limit-marker"
      />
    </span>
  </span>
</template>

<style scoped>
.rb {
  display: flex;
  min-width: 110px;
  flex-direction: column;
  gap: 4px;
}
.top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.track {
  position: relative;
  display: block;
  height: 6px;
  border-radius: 3px;
  background: var(--surface-3);
}
.u {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
}
.rq,
.lm {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
}
.rq {
  background: var(--text-muted);
}
.lm {
  background: var(--critical);
}
.bg-info {
  background: var(--info);
}
.bg-violet {
  background: var(--chart-4);
}
.bg-critical {
  background: var(--critical);
}
.text-critical {
  color: var(--critical);
}
</style>
