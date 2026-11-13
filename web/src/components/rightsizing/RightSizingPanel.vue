<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleAlert, Scale } from '@lucide/vue';
import type { RightSizing } from '@watchlog/api-types';
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useLoader } from '@/composables/useLoader';
import { period, rightSizingPath } from '@/lib/rightsizing';
import { LINKS } from '@/lib/links';
import RightSizingList from './RightSizingList.vue';

// The "Right-sizing" card of a workload, a Docker container or a Compose service (ADR-168):
// its requests and limits against the last 7 days of use, in sentences. The answer is kept
// an hour by the backend, so it is read once per visit.
const props = defineProps<{
  clusterId: string;
  /** The API's filters: namespace + kind + workload, host + container, or project + service. */
  query: Record<string, string | undefined>;
  /** The object's name, for the "fits" and "too new" lines. */
  name: string;
}>();
const { t } = useI18n();

const page = useLoader(() => api<RightSizing>(rightSizingPath(props.clusterId, props.query)));
onMounted(page.load);

const a = computed(() => page.data.value ?? null);
const hours = computed(() => Math.max(0, ...(a.value?.hints.map((h) => h.basedOn.hours) ?? [0])));
const short = computed(() => a.value?.notEnoughHistory ?? []);
// "Too new" only when nothing else could be said.
const tooNew = computed(() => !!a.value && a.value.hints.length === 0 && short.value.length > 0);
const shortHours = computed(() => Math.max(0, ...short.value.map((s) => s.hours)));
</script>

<template>
  <section
    aria-labelledby="rightsizing-title"
    class="overflow-hidden rounded-card border border-border bg-surface-1"
    data-testid="rightsizing-panel"
  >
    <header
      class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border px-4 py-3"
    >
      <Scale class="size-4.5 shrink-0 text-info" aria-hidden="true" />
      <h2 id="rightsizing-title" class="text-14 font-semibold text-text">
        {{ $t('rightSizing.title') }}
      </h2>
      <span
        v-if="a && a.hints.length"
        class="ml-auto text-12 text-text-muted"
        data-testid="rightsizing-based"
        >{{ $t('rightSizing.basedOn', { period: period(hours, t) }) }}</span
      >
    </header>

    <div
      v-if="!a && !page.error.value"
      class="flex flex-col gap-2 p-4"
      role="status"
      :aria-label="$t('common.loading')"
    >
      <Skeleton class="w-4/5 text-13" />
      <Skeleton class="w-3/5 text-13" />
    </div>
    <div
      v-else-if="!a"
      class="flex flex-wrap items-center gap-3 px-4 py-3 text-13 text-text-muted"
      role="status"
      data-testid="rightsizing-error"
    >
      <CircleAlert class="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
      <span class="min-w-0 flex-1">{{ $t('rightSizing.error') }}</span>
      <button type="button" class="text-primary hover:underline max-lg:min-h-11" @click="page.load">
        {{ $t('common.retry') }}
      </button>
    </div>
    <template v-else>
      <RightSizingList v-if="a.hints.length" :hints="a.hints" />
      <p v-else-if="tooNew" class="px-4 py-3 text-13 text-text-muted" data-testid="rightsizing-new">
        {{
          $t('rightSizing.notEnough', {
            name,
            hours: Math.round(shortHours * 10) / 10,
            needed: short[0]!.needed,
          })
        }}
      </p>
      <p v-else class="px-4 py-3 text-13 text-text-muted" data-testid="rightsizing-fits">
        {{ $t('rightSizing.fits', { name, period: period(a.window.hours, t) }) }}
      </p>
      <p class="border-t border-border px-4 py-2.5 text-12 text-text-subtle">
        {{ $t('rightSizing.footnote') }}
        <a
          :href="LINKS.rightSizing"
          target="_blank"
          rel="noopener"
          class="text-primary hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
          >{{ $t('rightSizing.how') }}</a
        >
      </p>
    </template>
  </section>
</template>
