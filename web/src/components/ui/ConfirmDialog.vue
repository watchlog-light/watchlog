<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';

// The question before something is deleted or someone loses access (ADR-219): what will
// happen in one or two plain lines, who or what it is about, Cancel focused, a danger button
// that shows progress and can't be pressed twice. Escape and Cancel change nothing. The
// dialog runs `action` itself: it closes when the action worked, and stays with the error
// when it didn't, so what the user sees behind it is still true.
const props = withDefaults(
  defineProps<{
    title: string;
    /** What will happen: one or two short lines (a slot named "body" replaces them). */
    lines?: string[];
    /** The name or email it is about, on a line of its own. */
    subject?: string;
    /** The danger button's words: the action itself ("Revoke invite"), never "OK". */
    confirmLabel: string;
    /** Does it; throws when it failed. */
    action: () => Promise<unknown>;
    /** The words for a failure, where the page has its own; else the server's message. */
    errorText?: (err: unknown) => string | undefined;
    testid?: string;
  }>(),
  { lines: () => [], subject: undefined, errorText: undefined, testid: 'confirm' },
);
const open = defineModel<boolean>('open', { required: true });
const { t } = useI18n();

const busy = ref(false);
const error = ref<string>();
const cancel = ref<InstanceType<typeof BaseButton> | null>(null);

watch(open, (now) => {
  if (now) error.value = undefined;
});

async function confirm() {
  // A second press while the first is on its way does nothing.
  if (busy.value) return;
  busy.value = true;
  error.value = undefined;
  try {
    await props.action();
    open.value = false;
  } catch (err) {
    error.value =
      props.errorText?.(err) ??
      (err instanceof ApiError && err.status !== 0 ? err.message : t('confirm.failed'));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ModalDialog
    v-model:open="open"
    :title="title"
    :locked="busy"
    :initial-focus="() => (cancel?.$el as HTMLElement | undefined) ?? null"
  >
    <div class="flex flex-col gap-4" :data-testid="`${testid}-dialog`">
      <p
        v-if="subject"
        class="text-14 font-medium wrap-anywhere text-text"
        :data-testid="`${testid}-subject`"
      >
        {{ subject }}
      </p>
      <slot name="body">
        <div class="flex flex-col gap-1.5 text-13 leading-relaxed text-text">
          <p v-for="line in lines" :key="line">{{ line }}</p>
        </div>
      </slot>
      <p
        v-if="error"
        class="rounded-control border border-border bg-surface-2 px-3 py-2 text-13 wrap-anywhere text-critical"
        role="alert"
        :data-testid="`${testid}-error`"
      >
        {{ error }}
      </p>
      <div class="flex justify-end gap-2 border-t border-border pt-4 max-sm:flex-col-reverse">
        <BaseButton
          ref="cancel"
          variant="secondary"
          :disabled="busy"
          :data-testid="`${testid}-cancel`"
          @click="open = false"
        >
          {{ $t('common.cancel') }}
        </BaseButton>
        <BaseButton
          variant="danger"
          :loading="busy"
          :data-testid="`${testid}-confirm`"
          @click="confirm"
        >
          {{ confirmLabel }}
        </BaseButton>
      </div>
    </div>
  </ModalDialog>
</template>
