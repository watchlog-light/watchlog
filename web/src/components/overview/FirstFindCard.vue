<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Sparkles, X } from '@lucide/vue';
import type { FirstFind } from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

// The first find (0.13.0, ADR-230): once per user and per cluster or fleet, the first time
// either list isn't empty, the Overview says what WatchLog found on its own, what it watches
// for and the most urgent item. Gone for good after a click on either button or ×; never in
// demo mode (the server says `show: false` there and for API tokens).
const props = defineProps<{ clusterId: string; kind: 'kubernetes' | 'server' }>();
const { t } = useI18n();
const auth = useAuthStore();
const data = ref<FirstFind | null>(null);
const hidden = ref(false);

async function load() {
  data.value = null;
  hidden.value = false;
  if (auth.demoMode) return;
  try {
    data.value = await api<FirstFind>(`/clusters/${props.clusterId}/first-find`);
  } catch {
    data.value = null;
  }
}
watch(() => props.clusterId, load, { immediate: true });

const show = computed(() => !hidden.value && !!data.value?.show);
function dismiss() {
  hidden.value = true;
  void api(`/clusters/${props.clusterId}/first-find/dismiss`, { method: 'POST' }).catch(
    () => undefined,
  );
}

const urgent = computed(() => {
  const u = data.value?.urgent;
  if (!u) return null;
  const name = u.node ? `${u.name} (${u.node})` : u.name;
  if (u.kind === 'certificate') {
    const d = u.daysLeft ?? 0;
    return d < 0
      ? t('firstFind.urgent.expired', { name, n: -d }, -d)
      : t('firstFind.urgent.expires', { name, n: d }, d);
  }
  return t(
    `firstFind.urgent.job.${u.state === 'missed' ? 'missed' : u.state === 'slow' ? 'slow' : 'failed'}`,
    { name },
  );
});
</script>

<template>
  <section
    v-if="show && data"
    class="relative flex flex-col gap-2 rounded-card border border-primary/40 bg-primary/5 py-4 pr-12 pl-5"
    aria-labelledby="first-find-h"
    data-testid="first-find"
  >
    <h2 id="first-find-h" class="flex items-center gap-2 text-16 font-semibold text-text">
      <Sparkles class="size-4.5 shrink-0 text-primary" aria-hidden="true" />
      {{
        $t('firstFind.title', {
          certs: $t('firstFind.certs', { n: data.certificates }, data.certificates),
          jobs: $t('firstFind.jobs', { n: data.jobs }, data.jobs),
        })
      }}
    </h2>
    <p class="text-14 leading-relaxed text-text-muted">
      {{ kind === 'kubernetes' ? $t('firstFind.howKube') : $t('firstFind.howServer') }}
    </p>
    <p v-if="urgent" class="text-14 font-medium text-warning-text" data-testid="first-find-urgent">
      {{ urgent }}
    </p>
    <div class="mt-1 flex flex-wrap gap-2">
      <RouterLink
        :to="{ name: 'certificates' }"
        class="inline-flex h-9 items-center rounded-control bg-primary px-3.5 text-14 font-medium text-on-primary hover:bg-primary-hover max-lg:min-h-11"
        data-testid="first-find-certs"
        @click="dismiss"
        >{{ $t('firstFind.seeCerts') }}</RouterLink
      >
      <RouterLink
        :to="{ name: 'scheduled-jobs' }"
        class="inline-flex h-9 items-center rounded-control border border-border-strong px-3.5 text-14 font-medium text-text hover:bg-surface-2 max-lg:min-h-11"
        data-testid="first-find-jobs"
        @click="dismiss"
        >{{ $t('firstFind.seeJobs') }}</RouterLink
      >
    </div>
    <button
      type="button"
      class="absolute top-2.5 right-2.5 inline-flex size-9 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text max-lg:size-11"
      :aria-label="$t('firstFind.dismiss')"
      data-testid="first-find-dismiss"
      @click="dismiss"
    >
      <X class="size-4.5" aria-hidden="true" />
    </button>
  </section>
</template>
