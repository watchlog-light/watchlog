<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { ApiTokenStatus } from '@watchlog/api-types';

// A token's status as a labelled badge: the label carries the meaning, the colour helps.
defineProps<{ status: ApiTokenStatus }>();
const TONE: Record<ApiTokenStatus, string> = {
  active: 'bg-primary-soft text-ok',
  expires_soon: 'bg-warning/15 text-warning',
  never: 'border border-warning/40 text-warning',
  expired: 'bg-surface-3 text-text-muted',
  revoked: 'bg-surface-3 text-text-muted',
};
</script>

<template>
  <span
    :class="[
      'inline-flex h-[22px] items-center rounded-full px-2 text-12 font-medium whitespace-nowrap',
      TONE[status],
    ]"
    :data-status="status"
  >
    {{ $t(`apiTokens.status.${status}`) }}
  </span>
</template>
