<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { since } from '@/lib/time';
import type { Attention } from '../../api';

// "Needs attention" (ADR-234), as the Overview shows it: severity, what, where and why, and how
// long; a row opens the device (at its port when there is one). Wireless and Storage share it.
defineProps<{ items: Attention[]; title: string }>();

const SEV: Record<string, string> = {
  critical: 'border-critical/50 text-critical-text',
  warning: 'border-warning/50 text-warning-text',
};
</script>

<template>
  <section
    class="rounded-card border border-border bg-surface-1"
    :aria-label="title"
    data-testid="network-attention"
  >
    <div class="flex items-center gap-2 border-b border-border px-4 py-3">
      <h2 class="text-14 font-semibold text-text">{{ title }}</h2>
      <span class="rounded-full bg-surface-2 px-1.5 text-12 text-text-muted tabular">{{
        items.length
      }}</span>
    </div>
    <RouterLink
      v-for="a in items"
      :key="a.alertId"
      :to="{
        name: 'network-device',
        params: { id: a.deviceId },
        query: a.port ? { port: a.port } : {},
      }"
      class="grid grid-cols-[88px_1fr_auto] items-center gap-3 border-t border-border px-4 py-2.5 first-of-type:border-t-0 hover:bg-surface-2 max-md:min-h-11"
      data-testid="network-attention-row"
    >
      <span>
        <span
          class="inline-flex h-5 items-center rounded-full border px-2 text-11 font-semibold uppercase"
          :class="SEV[a.severity]"
          >{{ $t(`net.severity.${a.severity}`) }}</span
        >
      </span>
      <span class="flex min-w-0 flex-col">
        <span class="truncate text-13 font-medium text-text">{{ a.what }}</span>
        <span class="truncate text-12 text-text-muted">{{
          a.why ? `${a.where} · ${a.why}` : a.where
        }}</span>
      </span>
      <span class="font-mono text-12 text-text-subtle" :title="a.since">{{ since(a.since) }}</span>
    </RouterLink>
  </section>
</template>
