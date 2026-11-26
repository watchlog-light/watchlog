<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// One option of the Combobox (ADR-239): its check mark, icon or status dot, its label with what
// was typed highlighted, a badge, and its description. In a windowed list every row has one
// height, so a description is one line there and the option's group is named on the row.
import { Check } from '@lucide/vue';
import { ComboboxItemIndicator } from 'reka-ui';
import { computed } from 'vue';
import type { ComboboxOption } from '@/components/ui/ComboBox.vue';
import { highlight } from '@/lib/highlight';

const props = defineProps<{
  option: ComboboxOption;
  /** What was typed, split into words. */
  terms: string[];
  /** A row of a windowed list: one line each, the group on the row. */
  windowed?: boolean;
}>();
const label = computed(() => highlight(props.option.label, props.terms));
const description = computed(() =>
  props.option.description ? highlight(props.option.description, props.terms) : [],
);
</script>

<template>
  <span class="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
    <ComboboxItemIndicator
      ><Check class="size-3.5 text-link" aria-hidden="true"
    /></ComboboxItemIndicator>
  </span>
  <component
    :is="option.icon"
    v-if="option.icon"
    class="mt-0.5 size-3.5 shrink-0 text-text-muted"
    aria-hidden="true"
  />
  <span
    v-if="option.dot"
    :class="['mt-1.5 size-2 shrink-0 rounded-full', option.dot]"
    aria-hidden="true"
  />
  <span class="min-w-0 flex-1">
    <span class="flex items-center gap-2">
      <span class="truncate"
        ><template v-for="(p, i) in label" :key="i"
          ><mark
            v-if="p.hit"
            class="bg-transparent font-semibold text-link"
            data-testid="combobox-hit"
            >{{ p.text }}</mark
          ><template v-else>{{ p.text }}</template></template
        ></span
      >
      <span
        v-if="option.badge"
        class="inline-flex h-4.5 shrink-0 items-center rounded-full border border-info/50 px-1.5 text-12 font-semibold text-info-text"
        >{{ option.badge }}</span
      >
      <span
        v-if="windowed && option.group"
        class="ml-auto shrink-0 pl-2 text-12 text-text-subtle"
        >{{ option.group }}</span
      >
    </span>
    <span
      v-if="option.description"
      :class="['block text-12 text-text-muted', windowed ? 'truncate' : '']"
      ><template v-for="(p, i) in description" :key="i"
        ><mark v-if="p.hit" class="bg-transparent font-semibold text-link">{{ p.text }}</mark
        ><template v-else>{{ p.text }}</template></template
      ></span
    >
  </span>
</template>
