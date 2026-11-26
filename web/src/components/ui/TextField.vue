<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ref, useId } from 'vue';

defineProps<{
  label: string;
  type?: 'text' | 'email' | 'password';
  autocomplete?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  minlength?: number;
  maxlength?: number;
  /** A code to type as it is printed (a setup code, a one-time code): spaced capitals. */
  mono?: boolean;
  /** Something technical that keeps its own case (an address, a metric's name): monospace. */
  technical?: boolean;
  readonly?: boolean;
  placeholder?: string;
  inputmode?: 'text' | 'numeric' | 'email';
}>();

const model = defineModel<string>({ required: true });
const id = useId();
const input = ref<HTMLInputElement | null>(null);
/** For a form that sends the user back to the field with the problem. */
defineExpose({
  focus: () => {
    input.value?.focus();
    input.value?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  },
});
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label :for="id" class="text-13 font-medium text-text">{{ label }}</label>
    <input
      :id="id"
      ref="input"
      v-model="model"
      :type="type ?? 'text'"
      :autocomplete="autocomplete"
      :required="required"
      :readonly="readonly"
      :placeholder="placeholder"
      :inputmode="inputmode"
      :minlength="minlength"
      :maxlength="maxlength"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="error || hint ? `${id}-help` : undefined"
      :class="[
        // 44 px to tap below 1024 px; 16 px text on phones so iOS doesn't zoom in on focus.
        'h-9 rounded-control border bg-surface-3 px-3 text-14 text-text placeholder:text-text-subtle max-lg:h-11 max-md:text-16',
        'focus:border-border-strong',
        error ? 'border-critical' : 'border-border',
        // A code's own capitals never reach its placeholder: that one is written as it reads.
        mono
          ? 'font-mono tracking-wider uppercase placeholder:tracking-normal placeholder:normal-case'
          : '',
        technical ? 'font-mono' : '',
        readonly ? 'cursor-default text-text-muted' : '',
      ]"
    />
    <p
      v-if="error || hint"
      :id="`${id}-help`"
      :role="error ? 'alert' : undefined"
      :class="['text-12', error ? 'text-critical-text' : 'text-text-muted']"
    >
      {{ error ?? hint }}
    </p>
  </div>
</template>
