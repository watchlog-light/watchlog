<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CalendarClock, ShieldCheck } from '@lucide/vue';
import { computed, ref } from 'vue';
import AgentUpdateDialog from '@/components/agents/AgentUpdateDialog.vue';
import { LINKS } from '@/lib/links';

// The Certificates and Scheduled jobs pages with nothing found yet (0.13.0, ADR-230): in the
// platform's words, how they are found (ports or Services and Ingresses; timers and crontabs
// or CronJobs), which agents are too old to look (with the update dialog), and the docs.
const props = defineProps<{
  what: 'certs' | 'jobs';
  clusterId: string;
  clusterName: string;
  kind: 'kubernetes' | 'server';
  agents: { node: string; version: string }[];
  /** No agent has reported a first read yet. */
  waiting: boolean;
}>();
const open = ref(false);
const kube = computed(() => props.kind === 'kubernetes');
const icon = computed(() => (props.what === 'certs' ? ShieldCheck : CalendarClock));
const docs = computed(() => (props.what === 'certs' ? LINKS.certsHow : LINKS.jobsHow));
</script>

<template>
  <section
    class="mx-auto flex w-full max-w-xl flex-col gap-3 rounded-card border border-border bg-surface-1 px-6 py-8"
    :data-testid="`${what}-empty`"
  >
    <div
      class="flex size-11 items-center justify-center rounded-card bg-surface-2 text-text-muted"
      aria-hidden="true"
    >
      <component :is="icon" class="size-5.5" />
    </div>
    <h2 class="text-16 font-semibold text-text">
      {{ $t(`emptyFound.${what}.title`, { name: clusterName }) }}
    </h2>
    <p class="text-14 leading-relaxed text-text-muted">
      {{ $t(`emptyFound.${what}.${kube ? 'kube' : 'server'}`) }}
    </p>
    <p v-if="waiting" class="text-13 text-text-muted">{{ $t('emptyFound.waiting') }}</p>
    <p
      v-if="agents.length"
      class="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-control border border-warning/40 bg-warning/10 px-3 py-2 text-13 text-text"
      data-testid="empty-older"
    >
      <span>
        <b class="font-semibold">{{
          kube
            ? $t('emptyFound.olderCluster', { version: agents[0]!.version })
            : $t('emptyFound.olderServers', { n: agents.length }, agents.length)
        }}</b>
        <span v-if="!kube" class="text-text-muted">
          ·
          {{
            $t(
              'emptyFound.cantLook',
              {
                names: agents
                  .slice(0, 4)
                  .map((a) => a.node)
                  .join(', '),
              },
              agents.length,
            )
          }}</span
        >
      </span>
      <button
        type="button"
        class="font-medium text-link hover:underline max-lg:min-h-11"
        data-testid="empty-update"
        @click="open = true"
      >
        {{ $t('emptyFound.update') }} →
      </button>
    </p>
    <a
      :href="docs"
      target="_blank"
      rel="noopener"
      class="self-start text-14 font-medium text-link hover:underline max-lg:min-h-11"
      data-testid="empty-docs"
      >{{ $t('emptyFound.docs') }} →</a
    >
    <AgentUpdateDialog v-if="agents.length" v-model:open="open" :cluster-id="clusterId" />
  </section>
</template>
