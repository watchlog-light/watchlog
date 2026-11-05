<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { KubeEvent } from '@watchlog/api-types';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { since } from '@/lib/time';
import TonePill from './TonePill.vue';

// Kubernetes events, newest first; Warning events carry the warning tone.
withDefaults(defineProps<{ events: KubeEvent[]; showObject?: boolean }>(), { showObject: true });
const router = useRouter();

function link(e: KubeEvent): RouteLocationRaw | null {
  if (e.involvedKind === 'Node') return { name: 'node', params: { name: e.involvedName } };
  if (e.involvedKind === 'Pod' && e.namespace && router.hasRoute('pod')) {
    return { name: 'pod', params: { namespace: e.namespace, name: e.involvedName } };
  }
  return null;
}
</script>

<template>
  <ul
    class="divide-y divide-border rounded-card border border-border bg-surface-1"
    data-testid="event-list"
  >
    <li
      v-for="e in events"
      :key="`${e.involvedKind}/${e.namespace}/${e.involvedName}/${e.reason}/${e.lastSeen}`"
      class="flex flex-col gap-0.5 px-4 py-2.5"
    >
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <TonePill :tone="e.type === 'Warning' ? 'warning' : 'neutral'" :label="e.reason" />
        <template v-if="showObject">
          <component
            :is="link(e) ? 'RouterLink' : 'span'"
            :to="link(e) ?? undefined"
            :class="['min-w-0 truncate text-13 text-text', link(e) ? 'hover:underline' : '']"
          >
            <span class="text-text-muted">{{ e.involvedKind }}</span>
            {{ e.namespace ? `${e.namespace}/` : '' }}{{ e.involvedName }}
          </component>
        </template>
        <span class="ml-auto font-mono text-12 text-text-subtle tabular">
          <template v-if="e.count > 1">{{ $t('kube.events.times', { n: e.count }) }} · </template>
          {{ $t('kube.ago', { d: since(e.lastSeen) }) }}
        </span>
      </div>
      <p class="text-13 break-words text-text-muted">{{ e.message }}</p>
    </li>
  </ul>
</template>
