<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { LifeBuoy, LogOut } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { cloudApi } from '@/api/cloud';
import BaseButton from '@/components/ui/BaseButton.vue';
import { useAuthStore } from '@/stores/auth';

// Support mode (ADR-179): over every page while a WatchLog staff member looks at this org in
// a read-only session. Says whose org, why, until when, that nothing can be changed, and
// leaves it. It can't be hidden: whoever looks at the screen must know.
const auth = useAuthStore();
const s = computed(() => auth.support);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 30_000);
});
onBeforeUnmount(() => clearInterval(timer));

const minutesLeft = computed(() =>
  s.value ? Math.max(0, Math.ceil((Date.parse(s.value.expiresAt) - now.value) / 60_000)) : 0,
);
const until = computed(() =>
  s.value
    ? new Date(s.value.expiresAt).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '',
);
const leaving = ref(false);
async function leave() {
  leaving.value = true;
  try {
    await cloudApi.leaveSupport();
  } finally {
    // A full load: no store keeps the org's data after the session.
    window.location.assign('/login');
  }
}
</script>

<template>
  <div
    v-if="s"
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-13 text-text md:px-6"
    role="region"
    :aria-label="$t('cloud.support.bannerLabel')"
    data-testid="support-banner"
  >
    <LifeBuoy class="size-4 shrink-0 text-warning" aria-hidden="true" />
    <p class="min-w-0 flex-1">
      <strong class="font-semibold">{{ $t('cloud.support.bannerTitle') }}</strong>
      {{
        $t('cloud.support.banner', {
          org: s.org.name,
          staff: s.staffEmail,
          until,
          n: minutesLeft,
        })
      }}
      <span class="block text-12 text-text-muted" data-testid="support-reason">{{
        $t('cloud.support.reason', { reason: s.reason })
      }}</span>
    </p>
    <BaseButton
      variant="secondary"
      class="max-sm:w-full"
      :loading="leaving"
      data-testid="support-leave"
      @click="leave"
    >
      <LogOut class="size-4" aria-hidden="true" />
      {{ $t('cloud.support.leave') }}
    </BaseButton>
  </div>
</template>
