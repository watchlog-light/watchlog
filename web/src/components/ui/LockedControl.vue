<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import TooltipHint from './TooltipHint.vue';

// A control a Viewer can't use stays visible, locked (ADR-140): its buttons and inputs
// are disabled through a disabled fieldset (mouse, keyboard and screen readers alike),
// and hovering or focusing it says why. The server refuses the change too.
// `locked` overrides the role check (default: anyone who can't manage).
const props = withDefaults(defineProps<{ locked?: boolean; align?: 'start' | 'end' }>(), {
  locked: undefined,
  align: 'start',
});
const auth = useAuthStore();
const { t } = useI18n();
const isLocked = computed(() => props.locked ?? !auth.canManage);
const why = computed(() => (auth.demoMode ? t('roles.lockedDemo') : t('roles.locked')));
</script>

<template>
  <slot v-if="!isLocked" />
  <TooltipHint v-else :text="why" :align="align" data-testid="locked">
    <fieldset disabled class="m-0 inline-flex min-w-0 border-0 p-0 opacity-50" :aria-label="why">
      <slot />
    </fieldset>
  </TooltipHint>
</template>
