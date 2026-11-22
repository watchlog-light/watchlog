<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { EgressRow } from '@watchlog/api-types';
import { computed } from 'vue';
import { classLabel, showsPattern } from '@/lib/egress';

// A destination's badges (ADR-188): New, Raw IP, Failing, Expected (with its pattern), and
// the label of what it is when it isn't a plain DNS name (local name, private or public
// network, "Internet").
const props = defineProps<{
  row: Pick<EgressRow, 'badges' | 'class' | 'expected' | 'destination'>;
}>();
const TONE: Record<string, string> = {
  new: 'bg-warning/15 text-warning-text',
  raw_ip: 'bg-critical/15 text-critical-text',
  failing: 'bg-critical/15 text-critical-text',
  expected: 'bg-primary-soft text-link',
};
const label = computed(() => classLabel(props.row));
// "Raw IP" already says "public network".
const showClass = computed(() => label.value && props.row.class !== 'public_network');
</script>

<template>
  <span
    v-if="row.badges.length || showClass"
    class="flex flex-wrap items-center gap-1.5"
    data-testid="egress-badges"
  >
    <span
      v-for="b in row.badges"
      :key="b"
      :class="['rounded-full px-2 py-px text-12 font-semibold', TONE[b]]"
      :data-badge="b"
      :title="
        b === 'expected' && row.expected?.by
          ? $t('egress.expected.markedBy', { by: row.expected.by })
          : undefined
      "
    >
      <template v-if="b === 'expected' && showsPattern(row)">
        {{ $t('egress.badge.expectedPattern', { pattern: row.expected!.pattern }) }}
      </template>
      <template v-else>{{ $t(`egress.badge.${b}`) }}</template>
    </span>
    <span
      v-if="showClass"
      class="rounded-full bg-surface-3 px-2 py-px text-12 font-medium text-text-muted"
      :data-class="row.class"
      >{{ $t(label!) }}</span
    >
  </span>
</template>
