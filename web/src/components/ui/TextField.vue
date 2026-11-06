<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { useId } from 'vue';

defineProps<{
  label: string;
  type?: 'text' | 'email' | 'password';
  autocomplete?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  minlength?: number;
  maxlength?: number;
  mono?: boolean;
  readonly?: boolean;
  placeholder?: string;
}>();

const model = defineModel<string>({ required: true });
const id = useId();
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label :for="id" class="text-13 font-medium text-text">{{ label }}</label>
    <input
      :id="id"
      v-model="model"
      :type="type ?? 'text'"
      :autocomplete="autocomplete"
      :required="required"
      :readonly="readonly"
      :placeholder="placeholder"
      :minlength="minlength"
      :maxlength="maxlength"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="error || hint ? `${id}-help` : undefined"
      :class="[
        // 44 px to tap below 1024 px; 16 px text on phones so iOS doesn't zoom in on focus.
        'h-9 rounded-control border bg-surface-3 px-3 text-14 text-text placeholder:text-text-subtle max-lg:h-11 max-md:text-16',
        'focus:border-border-strong',
        error ? 'border-critical' : 'border-border',
        mono ? 'font-mono tracking-wider uppercase' : '',
        readonly ? 'cursor-default text-text-muted' : '',
      ]"
    />
    <p
      v-if="error || hint"
      :id="`${id}-help`"
      :class="['text-12', error ? 'text-critical' : 'text-text-muted']"
    >
      {{ error ?? hint }}
    </p>
  </div>
</template>
