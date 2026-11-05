<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ShieldAlert } from '@lucide/vue';
import TooltipHint from '@/components/ui/TooltipHint.vue';

// ADR-051: the node agent could not verify the kubelet's certificate and continued
// without verification (kubelet.tls: auto). Shown only in that case.
defineProps<{ compact?: boolean; align?: 'start' | 'end' }>();
</script>

<template>
  <TooltipHint :text="$t('kube.kubeletTls.hint')" :align="align">
    <span
      class="inline-flex items-center gap-1 rounded-full border border-warning bg-surface-2 px-2 py-0.5 text-12 font-medium whitespace-nowrap text-text"
      data-testid="kubelet-tls-badge"
    >
      <ShieldAlert class="size-3.5 text-warning" aria-hidden="true" />
      <span :class="{ 'sr-only': compact }">{{ $t('kube.kubeletTls.label') }}</span>
    </span>
  </TooltipHint>
</template>
