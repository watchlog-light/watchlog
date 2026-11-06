<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Search } from '@lucide/vue';
import { onBeforeUnmount, onMounted, ref } from 'vue';

// Page-level search box. "/" focuses it from anywhere on the page (unless the user is
// typing elsewhere); Esc clears it, and a second Esc leaves the field.
defineProps<{ label: string; placeholder: string }>();
const emit = defineEmits<{ clear: [] }>();
const model = defineModel<string>({ required: true });
const el = ref<HTMLInputElement>();

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function onGlobalKey(e: KeyboardEvent) {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
  e.preventDefault();
  el.value?.focus();
}

function onEscape() {
  if (model.value === '') el.value?.blur();
  else emit('clear');
}

onMounted(() => window.addEventListener('keydown', onGlobalKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey));
</script>

<template>
  <label class="relative flex h-9 min-w-0 flex-1 items-center max-lg:h-11 sm:max-w-sm">
    <span class="sr-only">{{ label }}</span>
    <Search
      class="pointer-events-none absolute left-3 size-4 text-text-subtle"
      aria-hidden="true"
    />
    <input
      ref="el"
      v-model="model"
      type="search"
      :placeholder="placeholder"
      autocomplete="off"
      spellcheck="false"
      aria-keyshortcuts="/"
      data-testid="search"
      class="h-9 w-full rounded-control border border-border bg-surface-3 pr-8 pl-9 text-14 max-lg:h-11 max-md:text-16 text-text placeholder:text-text-subtle focus:border-border-strong [&::-webkit-search-cancel-button]:hidden"
      @keydown.esc.prevent="onEscape"
    />
    <kbd
      v-if="model === ''"
      class="pointer-events-none absolute right-2 max-lg:hidden rounded border border-border px-1.5 font-mono text-12 text-text-subtle"
      aria-hidden="true"
      >/</kbd
    >
  </label>
</template>
