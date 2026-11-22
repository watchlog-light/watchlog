<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { WhatChangedRecent } from '@watchlog/api-types';
import { CircleCheck } from '@lucide/vue';
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import Skeleton from '@/components/ui/Skeleton.vue';
import { hhmm } from '@/lib/what-changed';
import { changeCauseText, episodeLabel, storyText } from '@/lib/what-changed-story';

// When everything is inside (0.14.0, ADR-231): the map is all green, and in the story's place
// one line, then the last 7 days' episodes as compact cards (when, the sentence, the linked
// change), each selecting itself; or "Nothing left its usual range in the last 7 days."
const props = defineProps<{ clusterId: string; total: number; hideOwn: boolean }>();
const emit = defineEmits<{ select: [episode: { from: string; to: string | null }] }>();
const { t } = useI18n();
const tr = (k: string, v?: Record<string, unknown>, n?: number) =>
  n === undefined ? t(k, v ?? {}) : t(k, v ?? {}, n);
const recent = ref<WhatChangedRecent['episodes'] | null>(null);
async function load() {
  try {
    const r = await api<WhatChangedRecent>(
      `/what-changed/recent?cluster=${encodeURIComponent(props.clusterId)}${props.hideOwn ? '' : '&own=show'}`,
    );
    recent.value = r.episodes;
  } catch {
    recent.value = [];
  }
}
onMounted(load);
watch(() => [props.clusterId, props.hideOwn], load);
</script>

<template>
  <section
    class="flex flex-col gap-4 rounded-2xl border border-border bg-surface-1/45 px-6 py-5 max-md:px-4"
    aria-labelledby="wc-quiet-title"
    data-testid="wc-quiet"
  >
    <h3 id="wc-quiet-title" class="flex items-center gap-2 text-17 font-semibold text-text">
      <CircleCheck class="size-5 shrink-0 text-ok-text" aria-hidden="true" />
      {{ $t('whatChanged.quiet.all', { n: total.toLocaleString('en') }) }}
    </h3>
    <div class="flex flex-col gap-2">
      <span class="font-mono text-11 tracking-widest text-text-subtle uppercase">{{
        $t('whatChanged.quiet.recent')
      }}</span>
      <div v-if="recent === null" class="flex flex-col gap-2">
        <Skeleton v-for="i in 2" :key="i" shape="rect" class="h-16 w-full" />
      </div>
      <p v-else-if="!recent.length" class="text-14 text-text-muted" data-testid="wc-quiet-none">
        {{ $t('whatChanged.quiet.none') }}
      </p>
      <ul
        v-else
        class="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3 max-md:grid-cols-1"
        data-testid="wc-quiet-recent"
      >
        <li
          v-for="(e, i) in recent"
          :key="i"
          class="flex flex-col gap-1.5 rounded-card border border-border bg-surface-2/60 px-4 py-3"
          data-testid="wc-quiet-card"
        >
          <span class="font-mono text-12 text-text-muted">{{
            episodeLabel(e, Date.now(), tr, hhmm)
          }}</span>
          <span class="text-14 leading-snug text-text">{{ storyText(e.clauses, tr) }}</span>
          <span v-if="e.cause" class="text-13 text-ok-text">{{
            changeCauseText(e.cause, tr, hhmm)
          }}</span>
          <span v-else class="text-13 text-text-muted">{{ $t('whatChanged.causeBox.none') }}</span>
          <button
            type="button"
            class="self-start rounded-control px-1.5 py-1 text-13 font-medium text-link hover:bg-surface-3 max-lg:min-h-11"
            data-testid="wc-quiet-see"
            @click="emit('select', { from: e.from, to: e.to })"
          >
            {{ $t('whatChanged.quiet.see') }} →
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>
