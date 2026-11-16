<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Check, CircleAlert, CircleCheck, Minus } from '@lucide/vue';
import type { CauseCheck } from '@watchlog/api-types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { checkLine, checksSummary, say } from '@/lib/causes';

// "What we checked" (ADR-148): every check of a probable-cause answer, with what was found,
// and the summary line. The probable-cause panel's list, and What changed's evidence.
const props = defineProps<{
  checks: CauseCheck[];
  /** Open at first (the panel opens it when no cause is clear). */
  open?: boolean;
  /** A resolved alert's likely cause: "explained it". */
  resolved?: boolean;
}>();
const { t } = useI18n();
const tr = (key: string, values?: Record<string, unknown>, plural?: number) =>
  plural === undefined ? t(key, values ?? {}) : t(key, values ?? {}, plural);

const summary = computed(() =>
  checksSummary(props.checks, props.resolved)
    .map((l) => say(tr, l))
    .join(', '),
);

const CHECK_ICON: Record<CauseCheck['result'], { icon: typeof Check; class: string }> = {
  explains: { icon: CircleCheck, class: 'text-info' },
  ok: { icon: Check, class: 'text-ok' },
  possible: { icon: CircleAlert, class: 'text-warning' },
  not_run: { icon: CircleAlert, class: 'text-warning' },
  not_applicable: { icon: Minus, class: 'text-text-subtle' },
};
</script>

<template>
  <details
    :open="open"
    class="group rounded-card border border-border bg-bg px-3.5"
    data-testid="cause-checks"
  >
    <summary
      class="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 py-2 text-13 font-medium text-text marker:text-text-muted"
    >
      <span class="whitespace-nowrap">{{ $t('causes.panel.checks') }}</span>
      <span class="font-normal text-text-muted">· {{ summary }}</span>
    </summary>
    <ul class="flex flex-col gap-2 pb-3.5">
      <li
        v-for="(c, i) in checks"
        :key="i"
        class="grid grid-cols-[1rem_minmax(0,1fr)] gap-2.5 text-13 leading-normal text-text-muted"
        data-testid="cause-check"
        :data-result="c.result"
      >
        <component
          :is="CHECK_ICON[c.result].icon"
          :class="['mt-0.5 size-3.5', CHECK_ICON[c.result].class]"
          aria-hidden="true"
        />
        <span>
          <span class="sr-only">{{ $t(`causes.panel.checkResult.${c.result}`) }}: </span>
          <span class="text-text">{{ say(tr, checkLine(c).what) }}</span>
          — {{ say(tr, checkLine(c).result) }}
        </span>
      </li>
    </ul>
  </details>
</template>
