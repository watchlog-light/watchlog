<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { EVENT_HINTS, visibleEvents, type Overview } from '@/lib/overview';
import { since } from '@/lib/time';
import OverviewCard from './OverviewCard.vue';

// Warning events of the range, grouped by object and reason with counts. Events of
// objects already in Needs attention are left out, and WatchLog's own pods too unless
// asked for; a "+ N hidden" row says what was hidden. Well-known reasons get a fix hint.
const props = defineProps<{ overview: Overview }>();
const KEY = 'watchlog.overview.hideOwnPods';
function load() {
  try {
    return globalThis.localStorage?.getItem(KEY) !== 'false';
  } catch {
    return true;
  }
}
const hideOwn = ref(load());
watch(hideOwn, (v) => {
  try {
    globalThis.localStorage?.setItem(KEY, String(v));
  } catch {
    // per-browser convenience only
  }
});
const view = computed(() => visibleEvents(props.overview.events, hideOwn.value));
const shown = computed(() => view.value.shown.slice(0, 6));
const more = computed(() => view.value.shown.length - shown.value.length);
const count = (n: number) => new Intl.NumberFormat('en').format(n);
</script>

<template>
  <OverviewCard :title="$t('overview.events.title')" testid="card-events">
    <template #meta>
      <span class="text-12 text-text-subtle">{{ $t('overview.events.hint') }}</span>
    </template>
    <template #actions>
      <label
        class="inline-flex cursor-pointer items-center gap-1.5 text-12 text-text-muted select-none"
      >
        <input v-model="hideOwn" type="checkbox" class="accent-primary" data-testid="hide-own" />
        {{
          $t(
            overview.kind === 'docker'
              ? 'overview.events.hideOwnDocker'
              : 'overview.events.hideOwn',
          )
        }}
      </label>
      <RouterLink :to="{ name: 'events' }" class="text-13 text-primary">{{
        $t('overview.events.all')
      }}</RouterLink>
    </template>
    <ul class="flex flex-col">
      <li
        v-for="e in shown"
        :key="`${e.kind}/${e.namespace}/${e.name}/${e.reason}`"
        class="evr"
        data-testid="event-row"
      >
        <span class="rs">{{ e.reason }}</span>
        <span class="min-w-0">
          <span
            class="block truncate text-13 text-text"
            :title="`${e.kind} ${e.namespace ? `${e.namespace}/` : ''}${e.name}`"
          >
            {{ e.kind }}
            <code class="font-mono text-12"
              >{{ e.namespace ? `${e.namespace}/` : '' }}{{ e.name }}</code
            >
          </span>
          <span class="block truncate text-12 text-text-subtle" :title="e.message">{{
            e.message
          }}</span>
          <span
            v-if="EVENT_HINTS.has(e.reason)"
            class="block text-12 text-text-muted"
            data-testid="event-hint"
          >
            {{ $t(`overview.events.hints.${e.reason}`) }}
          </span>
        </span>
        <span class="text-right font-mono text-12 whitespace-nowrap text-text-subtle"
          >{{ count(e.count) }}×<br />{{
            $t('overview.events.ago', { t: since(e.lastSeen) })
          }}</span
        >
      </li>
      <li v-if="view.hidden.total" class="evr" data-testid="events-hidden">
        <span class="rs rs-muted">{{
          $t('overview.events.hidden', { n: view.hidden.total })
        }}</span>
        <span class="col-span-2 text-12 text-text-subtle">
          {{
            [
              view.hidden.covered
                ? $t(
                    'overview.events.hiddenCovered',
                    { n: view.hidden.covered },
                    view.hidden.covered,
                  )
                : '',
              view.hidden.own
                ? $t('overview.events.hiddenOwn', { n: view.hidden.own }, view.hidden.own)
                : '',
            ]
              .filter(Boolean)
              .join(' · ')
          }}
        </span>
      </li>
      <li v-if="more > 0" class="px-3.5 py-2.5 text-12 text-text-subtle">
        {{ $t('overview.events.more', { n: more }) }}
      </li>
    </ul>
    <p
      v-if="!shown.length && !view.hidden.total"
      class="px-3.5 py-6 text-13 text-text-muted"
      data-testid="events-empty"
    >
      {{ $t('overview.events.none') }}
    </p>
  </OverviewCard>
</template>

<style scoped>
.evr {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.evr:last-child {
  border-bottom: 0;
}
.rs {
  white-space: nowrap;
  border-radius: 6px;
  padding: 1px 7px;
  font-size: 12px;
  font-weight: 500;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
}
.rs-muted {
  color: var(--text-muted);
  background: var(--surface-3);
}
</style>
