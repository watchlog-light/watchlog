<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts" generic="M extends boolean = false">
import { Check, ChevronDown, X } from '@lucide/vue';
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxLabel,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
  ComboboxVirtualizer,
} from 'reka-ui';
import { computed, ref, watch, type Component } from 'vue';
import { useCompact, useNarrow } from '@/composables/useNarrow';

// Searchable select (SPEC §11.3, ADR-092): type to filter, keyboard navigation, groups,
// optional icon and description per option, multi-select with removable chips, a
// clear button and a "No matches" state; long lists are virtualised. Reka UI supplies
// the ARIA combobox/listbox mechanics; everything visible is styled here with tokens.
// Below 768 px the list opens as a full-width bottom sheet with its own search field
// and 44 px rows; below 1024 px the field itself is 44 px high.
export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  icon?: Component;
  group?: string;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    options: ComboboxOption[];
    /** Accessible name; shown as the visible label only by the caller. */
    label: string;
    multiple?: M;
    placeholder?: string;
    clearable?: boolean;
    disabled?: boolean;
    /** `field`: form input (h-9, surface-3). `toolbar`: top-bar filter (h-8, surface-1). */
    variant?: 'field' | 'toolbar';
    /** Shown in the trigger before the value. */
    icon?: Component;
    emptyText?: string;
    /** Lists longer than this are virtualised (namespaces, workloads, nodes). */
    virtualizeAbove?: number;
    testid?: string;
  }>(),
  {
    multiple: undefined,
    placeholder: undefined,
    icon: undefined,
    emptyText: undefined,
    testid: undefined,
    variant: 'field',
    virtualizeAbove: 100,
  },
);
const model = defineModel<M extends true ? string[] : string | null>({ required: true });

// A bare `multiple` attribute arrives as '' (the generic prop has no runtime Boolean type).
const isMulti = computed(
  () => (props.multiple as unknown) === true || (props.multiple as unknown) === '',
);
const open = ref(false);
const search = ref('');
watch(open, (o) => {
  if (!o) search.value = '';
});

const byValue = computed(() => new Map(props.options.map((o) => [o.value, o])));
const selected = computed<string[]>(() =>
  isMulti.value
    ? ((model.value as string[] | null) ?? [])
    : model.value
      ? [model.value as string]
      : [],
);

const filtered = computed(() => {
  const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return props.options;
  return props.options.filter((o) => {
    const text = `${o.label} ${o.description ?? ''} ${o.group ?? ''}`.toLowerCase();
    return terms.every((t) => text.includes(t));
  });
});
const groups = computed(() => {
  const out = new Map<string, ComboboxOption[]>();
  for (const o of filtered.value) out.set(o.group ?? '', [...(out.get(o.group ?? '') ?? []), o]);
  return [...out];
});
const virtual = computed(() => props.options.length > props.virtualizeAbove);
const narrow = useNarrow();
const compact = useCompact();

const singleLabel = computed(() =>
  !isMulti.value && selected.value[0]
    ? (byValue.value.get(selected.value[0])?.label ?? selected.value[0])
    : '',
);
const hasValue = computed(() => selected.value.length > 0);

function remove(value: string) {
  (model.value as string[]) = selected.value.filter((v) => v !== value);
}
function clear() {
  (model.value as string[] | string | null) = isMulti.value ? [] : null;
  search.value = '';
}

const anchor = computed(() => [
  'flex w-full min-w-0 items-center gap-1.5 rounded-control border px-2.5 text-text',
  isMulti.value ? 'flex-wrap py-0.5' : '',
  'focus-within:border-border-strong',
  props.variant === 'toolbar'
    ? 'min-h-8 bg-surface-1 text-13 hover:bg-surface-2'
    : 'min-h-9 bg-surface-3 text-14',
  // Touch: 48 px, so the search field inside is a 44 px target.
  'max-lg:min-h-12',
  props.disabled ? 'cursor-not-allowed opacity-60' : '',
  'border-border',
]);
</script>

<template>
  <ComboboxRoot
    v-model="model as never"
    v-model:open="open"
    :multiple="isMulti"
    :disabled="disabled"
    ignore-filter
    :reset-search-term-on-blur="true"
    class="relative min-w-0"
  >
    <!-- Phones: the field is one button; the search field is in the sheet. -->
    <ComboboxAnchor v-if="narrow" as-child>
      <ComboboxTrigger
        :class="[anchor, 'text-left']"
        :data-testid="testid"
        :aria-label="singleLabel ? `${label}: ${singleLabel}` : label"
      >
        <component
          :is="icon"
          v-if="icon"
          class="size-3.5 shrink-0 text-text-subtle"
          aria-hidden="true"
        />
        <span :class="['min-w-0 flex-1 truncate', hasValue ? 'text-text' : 'text-text-subtle']">
          {{
            isMulti
              ? selected.map((v) => byValue.get(v)?.label ?? v).join(', ') || placeholder
              : singleLabel || placeholder
          }}
        </span>
        <ChevronDown class="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
      </ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxAnchor v-else :class="anchor" :data-testid="testid">
      <component
        :is="icon"
        v-if="icon"
        class="size-3.5 shrink-0 text-text-subtle"
        aria-hidden="true"
      />
      <template v-if="isMulti">
        <span
          v-for="v in selected"
          :key="v"
          class="inline-flex max-w-40 items-center gap-1 rounded-[4px] border border-border bg-surface-2 py-0.5 pr-1 pl-1.5 text-12"
          data-testid="combobox-chip"
        >
          <span class="truncate">{{ byValue.get(v)?.label ?? v }}</span>
          <button
            v-if="!compact"
            type="button"
            class="rounded-[3px] text-text-subtle hover:text-text"
            :aria-label="$t('combobox.remove', { label: byValue.get(v)?.label ?? v })"
            @click.stop="remove(v)"
          >
            <X class="size-3" aria-hidden="true" />
          </button>
        </span>
      </template>
      <ComboboxInput
        v-model="search"
        :aria-label="singleLabel ? `${label}: ${singleLabel}` : label"
        :placeholder="isMulti && hasValue ? '' : singleLabel || placeholder"
        :display-value="() => ''"
        :class="[
          'h-7 min-w-12 flex-1 bg-transparent outline-none max-lg:h-11',
          // The chosen value is shown as the placeholder; one colour class, not two.
          !isMulti && singleLabel && !open
            ? 'placeholder:text-text'
            : 'placeholder:text-text-subtle',
        ]"
        @focus="open = true"
      />
      <button
        v-if="clearable && hasValue && !disabled"
        type="button"
        class="shrink-0 rounded-[3px] text-text-subtle hover:text-text max-lg:-mr-1 max-lg:flex max-lg:size-11 max-lg:items-center max-lg:justify-center"
        :aria-label="$t('combobox.clear')"
        data-testid="combobox-clear"
        @click.stop="clear"
      >
        <X class="size-3.5" aria-hidden="true" />
      </button>
      <ComboboxTrigger
        class="shrink-0 text-text-subtle max-lg:-mr-2.5 max-lg:flex max-lg:size-11 max-lg:items-center max-lg:justify-center"
        :aria-label="$t('combobox.open', { label })"
      >
        <ChevronDown class="size-3.5" aria-hidden="true" />
      </ComboboxTrigger>
    </ComboboxAnchor>

    <ComboboxPortal>
      <div v-if="narrow && open" class="fixed inset-0 z-50 bg-bg/60" aria-hidden="true" />
      <ComboboxContent
        :position="narrow ? 'inline' : 'popper'"
        :side-offset="4"
        :class="
          narrow
            ? 'fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-card border-t border-border-strong bg-surface-2 shadow-xl'
            : 'z-50 max-h-80 w-[var(--reka-combobox-trigger-width)] min-w-48 overflow-hidden rounded-card border border-border bg-surface-2 shadow-lg'
        "
        data-testid="combobox-content"
      >
        <div v-if="narrow" class="flex flex-col gap-2 border-b border-border p-3">
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate text-16 font-semibold text-text">{{ label }}</span>
            <button
              v-if="clearable && hasValue"
              type="button"
              class="h-11 rounded-control px-3 text-14 text-text-muted hover:bg-surface-3 hover:text-text"
              data-testid="combobox-clear"
              @click="clear"
            >
              {{ $t('combobox.clear') }}
            </button>
            <button
              type="button"
              class="flex size-11 items-center justify-center rounded-control text-text-muted hover:bg-surface-3 hover:text-text"
              :aria-label="$t('common.close')"
              @click="open = false"
            >
              <X class="size-5" aria-hidden="true" />
            </button>
          </div>
          <ComboboxInput
            v-model="search"
            :aria-label="label"
            :placeholder="$t('combobox.search')"
            :display-value="() => ''"
            class="h-11 w-full rounded-control border border-border bg-surface-3 px-3 text-16 text-text outline-none placeholder:text-text-subtle focus:border-border-strong"
          />
        </div>
        <ComboboxViewport
          :class="[
            'overflow-y-auto p-1',
            narrow ? 'min-h-0 flex-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]' : 'max-h-72',
          ]"
        >
          <ComboboxEmpty class="px-2 py-1.5 text-13 text-text-muted" data-testid="combobox-empty">
            {{ emptyText ?? $t('combobox.noMatches') }}
          </ComboboxEmpty>
          <ComboboxVirtualizer
            v-if="virtual"
            v-slot="{ option }"
            :options="filtered"
            :estimate-size="narrow ? 44 : 32"
            :text-content="(o: ComboboxOption) => o.label"
          >
            <ComboboxItem
              :value="option.value"
              :disabled="option.disabled"
              :class="[
                'flex w-full cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-13 text-text outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-3',
                narrow ? 'min-h-11 text-14' : '',
              ]"
            >
              <span class="flex size-3.5 shrink-0 items-center justify-center">
                <ComboboxItemIndicator
                  ><Check class="size-3.5 text-primary" aria-hidden="true"
                /></ComboboxItemIndicator>
              </span>
              <span class="truncate">{{ option.label }}</span>
            </ComboboxItem>
          </ComboboxVirtualizer>
          <template v-else>
            <ComboboxGroup v-for="[group, items] in groups" :key="group">
              <ComboboxLabel
                v-if="group"
                class="px-2 pt-2 pb-1 text-12 font-medium tracking-wide text-text-subtle uppercase"
              >
                {{ group }}
              </ComboboxLabel>
              <ComboboxItem
                v-for="o in items"
                :key="o.value"
                :value="o.value"
                :disabled="o.disabled"
                :class="[
                  'flex w-full cursor-pointer items-start gap-2 rounded-control px-2 py-1.5 text-13 text-text outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-surface-3',
                  narrow ? 'min-h-11 py-2.5 text-14' : '',
                ]"
                data-testid="combobox-option"
              >
                <span class="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
                  <ComboboxItemIndicator
                    ><Check class="size-3.5 text-primary" aria-hidden="true"
                  /></ComboboxItemIndicator>
                </span>
                <component
                  :is="o.icon"
                  v-if="o.icon"
                  class="mt-0.5 size-3.5 shrink-0 text-text-muted"
                  aria-hidden="true"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate">{{ o.label }}</span>
                  <span v-if="o.description" class="block text-12 text-text-muted">{{
                    o.description
                  }}</span>
                </span>
              </ComboboxItem>
            </ComboboxGroup>
          </template>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
