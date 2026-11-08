<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { useNarrow } from '@/composables/useNarrow';

// A dialog centred near the top on tablets and wider screens, a bottom sheet on phones
// (ADR-120). `locked` keeps it open on Escape and outside clicks: for a step the user has
// to finish, such as storing a token that is shown once.
const props = withDefaults(
  defineProps<{
    title: string;
    description?: string;
    /** The description in the warning colour (e.g. "it won't be shown again"). */
    warn?: boolean;
    size?: 'md' | 'lg';
    locked?: boolean;
  }>(),
  { description: undefined, warn: false, size: 'md', locked: false },
);
const open = defineModel<boolean>('open', { required: true });
const narrow = useNarrow();
const hold = (e: Event) => {
  if (props.locked) e.preventDefault();
};
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-bg/70" />
      <DialogContent
        :class="[
          'fixed z-50 flex flex-col gap-5 overflow-y-auto bg-surface-1 shadow-xl',
          narrow
            ? 'inset-x-0 bottom-0 max-h-[90dvh] rounded-t-card border-t border-border-strong px-4 pt-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]'
            : [
                'top-16 left-1/2 max-h-[calc(100dvh-6rem)] w-[calc(100%-2rem)] -translate-x-1/2 rounded-card border border-border p-6',
                size === 'lg' ? 'max-w-170' : 'max-w-135',
              ],
        ]"
        @escape-key-down="hold"
        @pointer-down-outside="hold"
        @interact-outside="hold"
      >
        <div class="flex items-start gap-3">
          <slot name="icon" />
          <div class="flex min-w-0 flex-col gap-1.5">
            <DialogTitle class="text-16 font-semibold wrap-break-word text-text">{{
              title
            }}</DialogTitle>
            <DialogDescription
              v-if="description"
              :class="['text-14 leading-relaxed', warn ? 'text-warning' : 'text-text-muted']"
            >
              {{ description }}
            </DialogDescription>
          </div>
        </div>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
