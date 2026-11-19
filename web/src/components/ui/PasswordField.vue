<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Check, Circle, Eye, EyeOff, LoaderCircle, Minus, X } from '@lucide/vue';
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { cloudApi } from '@/api/cloud';
import { leakCheck as askLeakedList, type LeakState } from '@/lib/password';

// The field where a new password is set (sign-up, first-run setup, a reset, an invite), as
// ADR-175 has it since 0.9.9:
//   - a checklist under the field that ticks as the user types: long enough, and (Cloud) not
//     in the leaked-password list. No composition rules;
//   - what is wrong, directly under the field, in words that say what to do;
//   - show/hide, and autocomplete="new-password", so the browser or password manager offers
//     and saves a strong password of its own (0.9.10: no suggestion of ours);
//   - when the leaked list can't be reached, nothing alarming: the server checks on send.
const props = withDefaults(
  defineProps<{
    label: string;
    /** The server's minimum length. */
    minLength: number;
    /** Check the leaked-password list as the user types (Cloud; the server checks there too). */
    leakCheck?: boolean;
    /** What the form or the server says about this field; replaces the field's own words. */
    error?: string;
    /** Milliseconds of quiet before the leaked list is asked. */
    debounceMs?: number;
  }>(),
  { leakCheck: false, error: undefined, debounceMs: 400 },
);
const model = defineModel<string>({ required: true });
const { t } = useI18n();
const id = useId();
const input = ref<HTMLInputElement | null>(null);

const shown = ref(false);
const longEnough = computed(() => model.value.length >= props.minLength);

const leak = ref<LeakState>('idle');
let timer: ReturnType<typeof setTimeout> | undefined;
let asked = 0;
watch(
  [model, () => props.leakCheck, () => props.minLength],
  () => {
    clearTimeout(timer);
    const mine = ++asked;
    if (!props.leakCheck || !longEnough.value) {
      leak.value = 'idle';
      return;
    }
    leak.value = 'checking';
    const password = model.value;
    timer = setTimeout(async () => {
      const result = await askLeakedList(password, cloudApi.passwordRange);
      // What was typed since then has its own check on the way.
      if (mine === asked) leak.value = result;
    }, props.debounceMs);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));

type ItemState = 'todo' | 'checking' | 'ok' | 'bad' | 'unknown';
interface Item {
  key: string;
  state: ItemState;
  text: string;
}
const LEAK_ITEM: Record<LeakState, ItemState> = {
  idle: 'todo',
  checking: 'checking',
  ok: 'ok',
  leaked: 'bad',
  unavailable: 'unknown',
};
const items = computed<Item[]>(() => [
  {
    key: 'length',
    state: longEnough.value ? 'ok' : 'todo',
    text: t('password.rules.length', { min: props.minLength }),
  },
  ...(props.leakCheck
    ? [
        {
          key: 'leak',
          state: LEAK_ITEM[leak.value],
          text: t(
            leak.value === 'checking'
              ? 'password.rules.leakChecking'
              : leak.value === 'leaked'
                ? 'password.rules.leakFound'
                : leak.value === 'unavailable'
                  ? 'password.rules.leakUnavailable'
                  : 'password.rules.leak',
          ),
        },
      ]
    : []),
]);
const ICONS = { todo: Circle, checking: LoaderCircle, ok: Check, bad: X, unknown: Minus };
const TONES: Record<ItemState, string> = {
  todo: 'text-text-muted',
  checking: 'text-text-muted',
  ok: 'text-ok',
  bad: 'text-critical',
  unknown: 'text-text-muted',
};

/** What is wrong, under the field: the form's or the server's word, else the leaked finding. */
const said = computed(
  () => props.error ?? (leak.value === 'leaked' ? t('password.leaked') : undefined),
);
/** For screen readers, when a rule's state changes (not with every key). */
const announce = computed(() =>
  model.value
    ? items.value.map((i) => `${t(`password.state.${i.state}`)}: ${i.text}`).join('. ')
    : '',
);

// The focus stays on the button: pressed again (Space, Enter), it hides again.
function toggle() {
  shown.value = !shown.value;
}

defineExpose({
  focus: () => {
    input.value?.focus();
    input.value?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  },
  /** What the page should stop on before sending: too short, or known to be leaked. */
  problem: (): 'tooShort' | 'leaked' | null =>
    !longEnough.value ? 'tooShort' : leak.value === 'leaked' ? 'leaked' : null,
});
</script>

<template>
  <div class="flex flex-col gap-1.5" data-testid="password-field">
    <label :for="id" class="text-13 font-medium text-text">{{ label }}</label>
    <div class="relative">
      <input
        :id="id"
        ref="input"
        v-model="model"
        :type="shown ? 'text' : 'password'"
        autocomplete="new-password"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        required
        :minlength="minLength"
        :aria-invalid="said ? 'true' : undefined"
        :aria-describedby="`${said ? `${id}-error ` : ''}${id}-rules`"
        :class="[
          // 44 px to tap below 1024 px; 16 px text on phones so iOS doesn't zoom in on focus.
          'h-9 w-full rounded-control border bg-surface-3 pr-11 pl-3 text-14 text-text placeholder:text-text-subtle max-lg:h-11 max-lg:pr-12 max-md:text-16',
          'focus:border-border-strong',
          said ? 'border-critical' : 'border-border',
          shown ? 'font-mono' : '',
        ]"
        data-testid="password-input"
      />
      <button
        type="button"
        class="absolute inset-y-0 right-0 inline-flex w-9 items-center justify-center rounded-control text-text-muted hover:text-text max-lg:w-11"
        :aria-label="$t(shown ? 'password.hide' : 'password.show')"
        :aria-pressed="shown"
        :aria-controls="id"
        data-testid="password-toggle"
        @click="toggle"
      >
        <EyeOff v-if="shown" class="size-4" aria-hidden="true" />
        <Eye v-else class="size-4" aria-hidden="true" />
      </button>
    </div>
    <p
      v-if="said"
      :id="`${id}-error`"
      role="alert"
      class="text-13 leading-relaxed text-critical"
      data-testid="password-error"
    >
      {{ said }}
    </p>
    <ul :id="`${id}-rules`" class="flex flex-col gap-1" data-testid="password-rules">
      <li
        v-for="item in items"
        :key="item.key"
        :class="['flex items-start gap-2 text-12 leading-relaxed', TONES[item.state]]"
        :data-rule="item.key"
        :data-state="item.state"
      >
        <component
          :is="ICONS[item.state]"
          :class="['mt-0.5 size-3.5 shrink-0', item.state === 'checking' ? 'animate-spin' : '']"
          aria-hidden="true"
        />
        <span>
          <span class="sr-only">{{ $t(`password.state.${item.state}`) }}: </span>{{ item.text }}
        </span>
      </li>
    </ul>
    <p class="sr-only" aria-live="polite" data-testid="password-announce">{{ announce }}</p>
  </div>
</template>
