<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { LockOpen } from '@lucide/vue';

// A profile with MD5 or DES ("older encryption"), or without SNMPv3 privacy ("not encrypted"),
// 1.0.4: a small, calm mark on its card and on its devices' pages. No alert, no colour of
// alarm: it says what the profile is, for whoever reads it.
defineProps<{ strength: 'older' | 'plain' }>();
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-11 leading-4 whitespace-nowrap text-text-muted"
    :title="$t(`netAdd.cred.strengthHint.${strength}`)"
    :data-testid="`strength-${strength}`"
  >
    <LockOpen class="size-3" aria-hidden="true" />{{ $t(`netAdd.cred.strength.${strength}`) }}
  </span>
</template>
