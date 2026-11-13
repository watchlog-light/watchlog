<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { passwordStrength, STRENGTH_LABELS } from '@/lib/password';

// Four bars under the password field (Signup.dc.html), and the rule in words. The words
// are read out (aria-live); the bars are decoration.
const props = defineProps<{ password: string; minLength: number; id?: string }>();
const score = computed(() => passwordStrength(props.password, props.minLength));
const label = computed(() => STRENGTH_LABELS[score.value]);
const tone = computed(() =>
  score.value <= 1 ? 'bg-critical' : score.value === 2 ? 'bg-warning' : 'bg-primary',
);
</script>

<template>
  <div class="flex flex-col gap-1.5" data-testid="password-strength" :data-score="score">
    <div class="flex gap-1" aria-hidden="true">
      <span
        v-for="i in 4"
        :key="i"
        :class="['h-1 flex-1 rounded-full', password && i <= score ? tone : 'bg-border']"
      />
    </div>
    <p :id="id" class="text-12 text-text-muted" aria-live="polite">
      {{ password ? `${$t(`cloud.strength.${label}`)} ` : ''
      }}{{ $t('cloud.strength.rule', { min: minLength }) }}
    </p>
  </div>
</template>
