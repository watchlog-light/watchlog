<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { KeyRound } from '@lucide/vue';
import type { Panel } from '@watchlog/api-types';
import BaseButton from '@/components/ui/BaseButton.vue';
import Skeleton from '@/components/ui/Skeleton.vue';

// A service-page panel's frame (ADR-135): its title and note, then one of loading,
// error, "needs a permission" (ADR-134: what is missing and how to grant it), empty, or
// the panel's own body. Line and stacked panels draw their own frame (TimeSeriesChart).
defineProps<{ panel: Panel; loading?: boolean; error?: boolean }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <section
    class="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
    :data-panel="panel.id"
    :data-kind="panel.kind"
    :data-state="panel.state"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h3 class="text-13 font-medium text-text-muted">{{ $t(panel.title) }}</h3>
      <span v-if="panel.note" class="text-12 text-text-subtle">{{
        $t(panel.note.key, panel.note.values ?? {})
      }}</span>
    </div>
    <div v-if="loading && panel.state !== 'ok'" role="status" :aria-label="$t('common.loading')">
      <Skeleton v-for="i in 3" :key="i" class="w-full" />
    </div>
    <div
      v-else-if="error || panel.state === 'error'"
      role="alert"
      class="flex flex-col items-start gap-2 text-13 text-text-subtle"
    >
      {{ $t('integrations.panel.error') }}
      <BaseButton variant="secondary" @click="$emit('retry')">{{ $t('common.retry') }}</BaseButton>
    </div>
    <div
      v-else-if="panel.state === 'needs_permission'"
      class="flex items-start gap-2.5 rounded-control border border-border bg-surface-2 px-3 py-2.5 text-13 text-text-muted"
      data-testid="needs-permission"
    >
      <KeyRound class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <span>
        {{ $t('integrations.panel.needsPermission') }}
        <template v-if="panel.missing">{{
          $te(panel.missing.key)
            ? $t(panel.missing.key, panel.missing.values ?? {})
            : $t('integrations.panel.missing', panel.missing.values ?? {})
        }}</template>
      </span>
    </div>
    <p
      v-else-if="panel.state === 'empty'"
      class="text-13 text-text-subtle"
      data-testid="panel-empty"
    >
      {{ $t('integrations.panel.empty') }}
    </p>
    <slot v-else />
  </section>
</template>
