<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseButton from '@/components/ui/BaseButton.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useRangeQuery } from '@/composables/useRangeQuery';
import { conditionSegments } from '@/lib/kube';
import { clockTime, rangeWindow } from '@/lib/time';
import { useUiStore } from '@/stores/ui';

// Node conditions over the selected range (SPEC §4.2): one row per condition, red where
// the condition signals a problem, grey where no data arrived.
const props = defineProps<{ clusterId?: string; node: string }>();
const { t } = useI18n();
const ORDER = ['Ready', 'MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'];

const scope = computed(() => ({ node: props.node }));
const q = useRangeQuery(() => props.clusterId, 'node.condition', scope);
const { timeRange } = storeToRefs(useUiStore());

const rows = computed(() => {
  const res = q.data.value;
  if (!res) return [];
  const [from, to] = rangeWindow(timeRange.value);
  return res.series
    .map((s) => {
      const condition = s.labels.condition ?? '';
      const segments = conditionSegments(condition, s.points, from, to, res.step);
      const badSeconds = segments.filter((x) => x.bad).reduce((n, x) => n + x.to - x.from, 0);
      return {
        condition,
        badSeconds,
        segments: segments.map((x) => ({
          ...x,
          left: ((x.from - from) / (to - from)) * 100,
          width: ((x.to - x.from) / (to - from)) * 100,
          title: `${condition}: ${
            x.bad === null
              ? t('kube.conditions.noData')
              : x.bad
                ? t('kube.conditions.bad')
                : t('kube.conditions.good')
          } · ${clockTime(new Date(x.from * 1000).toISOString())}–${clockTime(new Date(x.to * 1000).toISOString())}`,
        })),
      };
    })
    .sort((a, b) => {
      const i = ORDER.indexOf(a.condition);
      const j = ORDER.indexOf(b.condition);
      return (i < 0 ? 99 : i) - (j < 0 ? 99 : j) || a.condition.localeCompare(b.condition);
    });
});
const minutes = (s: number) => Math.max(1, Math.round(s / 60));
</script>

<template>
  <section
    class="rounded-card border border-border bg-surface-1 p-4"
    data-testid="condition-timeline"
  >
    <h3 class="mb-3 text-14 font-semibold text-text">{{ $t('kube.conditions.title') }}</h3>
    <div v-if="q.error.value" class="flex items-center gap-3 text-13 text-text-muted">
      {{ $t('kube.conditions.error') }}
      <BaseButton variant="ghost" @click="q.refresh">{{ $t('common.retry') }}</BaseButton>
    </div>
    <div
      v-else-if="q.loading.value && rows.length === 0"
      class="flex flex-col gap-3"
      role="status"
      :aria-label="$t('common.loading')"
    >
      <Skeleton v-for="i in 4" :key="i" shape="rect" class="h-4 w-full" />
    </div>
    <p v-else-if="rows.length === 0" class="text-13 text-text-muted">
      {{ $t('kube.conditions.empty') }}
    </p>
    <dl v-else class="flex flex-col gap-2.5">
      <div
        v-for="r in rows"
        :key="r.condition"
        class="grid grid-cols-[9rem_1fr] items-center gap-3 sm:grid-cols-[9rem_1fr_10rem]"
      >
        <dt class="truncate text-13 text-text">{{ r.condition }}</dt>
        <dd class="relative h-3 overflow-hidden rounded-full bg-surface-3">
          <span
            v-for="(s, i) in r.segments"
            :key="i"
            :title="s.title"
            :class="[
              'absolute inset-y-0',
              s.bad === null ? 'bg-surface-3' : s.bad ? 'bg-critical' : 'bg-ok/30',
            ]"
            :style="{ left: `${s.left}%`, width: `${s.width}%` }"
          />
        </dd>
        <dd class="hidden text-12 text-text-muted sm:block">
          {{
            r.badSeconds > 0
              ? $t('kube.conditions.badFor', { m: minutes(r.badSeconds) })
              : $t('kube.conditions.noProblems')
          }}
        </dd>
      </div>
    </dl>
  </section>
</template>
