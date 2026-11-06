<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { TriangleAlert } from '@lucide/vue';
import type { IngestFailure } from '@watchlog/api-types';
import { formatDateTime } from '@/lib/format';

// ADR-117: when the backend answers a cluster's agents with errors, its data is
// delayed or lost. The overview and Settings say so, instead of quietly showing old data.
defineProps<{ failure: IngestFailure }>();
</script>

<template>
  <div
    role="alert"
    class="flex items-start gap-3 rounded-card border border-critical bg-surface-1 px-4 py-3"
    data-testid="ingest-failing"
  >
    <TriangleAlert class="mt-0.5 size-5 shrink-0 text-critical" aria-hidden="true" />
    <div class="min-w-0">
      <p class="text-14 font-semibold text-text">
        {{ $t('clusters.ingest.title', { since: formatDateTime(failure.since) }) }}
      </p>
      <p class="text-13 text-text-muted">{{ $t('clusters.ingest.description') }}</p>
      <ul class="mt-1.5 flex flex-col gap-0.5 text-13 text-text-muted">
        <li v-for="e in failure.endpoints" :key="e.endpoint" data-testid="ingest-endpoint">
          {{
            $t('clusters.ingest.endpoint', {
              endpoint: $t(`clusters.ingest.endpoints.${e.endpoint}`),
              status: e.status,
            })
          }}<template v-if="e.message">: {{ e.message }}</template>
        </li>
      </ul>
    </div>
  </div>
</template>
