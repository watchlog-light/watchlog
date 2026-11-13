<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Check, ChevronRight, X } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { cloudApi, type FirstWeek, type FirstWeekStepId } from '@/api/cloud';

// "Get the most out of your first week" on the overview (ADR-176, Dashboard.dc.html),
// Cloud only: connect a channel, invite a teammate, connect an application, try MCP, see
// your first explained problem. Each step comes from the org's real state (the server
// reports each to the funnel once); the card hides when every step is done or when this
// user dismisses it. Cloud Free can't invite (one user): that step says Pro is needed.
const data = ref<FirstWeek | null>(null);
const dismissing = ref(false);

onMounted(async () => {
  try {
    data.value = await cloudApi.firstWeek();
  } catch {
    data.value = null; // The overview never depends on it.
  }
});

const LINKS: Record<FirstWeekStepId, RouteLocationRaw> = {
  channel: { name: 'settings', query: { tab: 'channels' } },
  teammate: { name: 'settings', query: { tab: 'users' } },
  application: { name: 'applications' },
  mcp: { name: 'settings', query: { tab: 'tokens' } },
  problem: { name: 'alerts' },
};
/** Plan & billing (Cloud slices 4–5 build the page; the link is its route). */
const BILLING: RouteLocationRaw = { name: 'settings', query: { tab: 'billing' } };

const steps = computed(() => data.value?.steps ?? []);
const done = computed(() => steps.value.filter((s) => s.done).length);
const visible = computed(
  () => !!data.value && !data.value.dismissed && done.value < steps.value.length,
);

async function dismiss() {
  dismissing.value = true;
  try {
    await cloudApi.dismissFirstWeek();
    if (data.value) data.value = { ...data.value, dismissed: true };
  } finally {
    dismissing.value = false;
  }
}
</script>

<template>
  <section
    v-if="visible"
    class="flex flex-col gap-3.5 rounded-card border border-border bg-surface-1 p-4 md:p-5"
    data-testid="first-week"
    aria-labelledby="first-week-title"
  >
    <div class="flex items-center justify-between gap-3">
      <h2 id="first-week-title" class="text-16 font-semibold text-text">
        {{ $t('onboarding.firstWeek.title') }}
      </h2>
      <div class="flex items-center gap-1">
        <span class="text-13 text-text-muted tabular" data-testid="first-week-count">{{
          $t('onboarding.firstWeek.count', { done, total: steps.length })
        }}</span>
        <button
          type="button"
          class="flex size-11 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text lg:size-8"
          :aria-label="$t('onboarding.firstWeek.dismiss')"
          :disabled="dismissing"
          data-testid="first-week-dismiss"
          @click="dismiss"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
    <div
      class="h-1.5 rounded-full bg-surface-3"
      role="progressbar"
      :aria-valuenow="done"
      aria-valuemin="0"
      :aria-valuemax="steps.length"
      :aria-label="$t('onboarding.firstWeek.progress')"
    >
      <div
        class="h-1.5 rounded-full bg-primary transition-[width]"
        :style="{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }"
      />
    </div>
    <ul class="flex flex-col">
      <li v-for="s in steps" :key="s.id" :data-testid="`first-week-${s.id}`" :data-done="s.done">
        <RouterLink
          :to="s.blocked === 'plan-limit' ? BILLING : LINKS[s.id]"
          class="flex min-h-11 items-start gap-3 rounded-control p-2.5 transition-colors hover:bg-surface-2"
        >
          <span
            v-if="s.done"
            class="mt-0.5 flex size-5.5 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary"
            aria-hidden="true"
            ><Check class="size-3.5" :stroke-width="3"
          /></span>
          <span
            v-else
            class="mt-0.5 size-5.5 shrink-0 rounded-full border-2 border-border-strong"
            aria-hidden="true"
          />
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              :class="[
                'text-14 font-medium',
                s.done ? 'text-text-muted line-through' : 'text-text',
              ]"
            >
              {{ $t(`onboarding.firstWeek.steps.${s.id}.title`) }}
              <span class="sr-only">{{
                s.done ? $t('onboarding.firstWeek.done') : $t('onboarding.firstWeek.todo')
              }}</span>
            </span>
            <span class="text-13 text-text-muted">{{
              s.blocked === 'plan-limit'
                ? $t('onboarding.firstWeek.needsPro')
                : $t(`onboarding.firstWeek.steps.${s.id}.body`)
            }}</span>
          </span>
          <ChevronRight
            v-if="!s.done"
            class="mt-1 size-4 shrink-0 text-text-subtle"
            aria-hidden="true"
          />
        </RouterLink>
      </li>
    </ul>
  </section>
</template>
