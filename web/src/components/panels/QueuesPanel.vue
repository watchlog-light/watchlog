<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowDown, ArrowUp } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import SearchField from '@/components/ui/SearchField.vue';
import { SEVERITY_TEXT, SEVERITY_TOKEN, type PanelOf } from '@/lib/panels';
import { formatDuration, formatRate } from '@/lib/units';
import { queueRoute } from '@/lib/service-links';
import { useServicePage } from '@/lib/service-page';

// RabbitMQ's queues (1.1.0): type, ready with a bar, unacked, in and out a second, consumers
// and how busy, drains in. The whole table sorts, searches and filters "no consumers"; the
// Overview's short list links to it. Each name opens the queue's page.
type Row = PanelOf<'queues'>['rows'][number];
const props = defineProps<{ panel: PanelOf<'queues'> }>();
const page = useServicePage();
const route = useRoute();

const search = ref('');
const noConsumers = ref(route.query.filter === 'no_consumers');
watch(
  () => route.query.filter,
  (f) => (noConsumers.value = f === 'no_consumers'),
);
type Key = 'need' | 'name' | 'ready' | 'unacked' | 'in' | 'out' | 'consumers' | 'drain';
const sortKey = ref<Key>('need');
const desc = ref(true);
function sortBy(k: Key) {
  if (sortKey.value === k) desc.value = !desc.value;
  else {
    sortKey.value = k;
    desc.value = k !== 'name';
  }
}
const drainRank = (r: Row) =>
  r.drain.state === 'never'
    ? 1e12
    : r.drain.state === 'growing'
      ? 1e11
      : r.drain.state === 'eta'
        ? r.drain.seconds
        : -1;
const value = (r: Row, k: Key): number | string =>
  k === 'name'
    ? r.name
    : k === 'drain'
      ? drainRank(r)
      : k === 'need'
        ? 0
        : ((r[k as 'ready'] as number | null) ?? -1);
const rows = computed(() => {
  const q = search.value.trim().toLowerCase();
  let out = props.panel.rows.filter(
    (r) =>
      (!q || r.name.toLowerCase().includes(q)) &&
      (!noConsumers.value || (r.consumers === 0 && r.type !== 'stream')),
  );
  if (sortKey.value !== 'need') {
    out = [...out].sort((a, b) => {
      const x = value(a, sortKey.value);
      const y = value(b, sortKey.value);
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return desc.value ? -c : c;
    });
  }
  return out;
});
const max = computed(() => Math.max(1, ...props.panel.rows.map((r) => r.ready)));
const ariaSort = (k: Key) =>
  sortKey.value === k ? (desc.value ? 'descending' : 'ascending') : 'none';
const cols: { key: Key; label: string; right?: boolean }[] = [
  { key: 'name', label: 'queue' },
  { key: 'ready', label: 'ready' },
  { key: 'unacked', label: 'unacked', right: true },
  { key: 'in', label: 'in', right: true },
  { key: 'out', label: 'out', right: true },
  { key: 'consumers', label: 'consumers', right: true },
  { key: 'drain', label: 'drain', right: true },
];
const drainText = (r: Row) => (r.drain.state === 'eta' ? formatDuration(r.drain.seconds) : null);
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="panel.full" class="flex flex-wrap items-center gap-3">
      <SearchField
        v-model="search"
        :label="$t('integrations.rabbitmq.panels.cols.searchQueues')"
        :placeholder="$t('integrations.rabbitmq.panels.cols.searchQueues')"
        data-testid="queues-search"
        @clear="search = ''"
      />
      <label class="inline-flex items-center gap-2 text-13 text-text max-lg:min-h-11">
        <input
          v-model="noConsumers"
          type="checkbox"
          class="size-4 accent-primary"
          data-testid="queues-no-consumers"
        />
        {{ $t('integrations.rabbitmq.panels.cols.noConsumers') }}
      </label>
    </div>
    <div class="-mx-4 overflow-x-auto">
      <table class="w-full min-w-[52rem] text-13">
        <thead>
          <tr
            class="border-b border-border text-left text-11 font-medium tracking-wider text-text-muted uppercase"
          >
            <th
              v-for="c in cols"
              :key="c.key"
              scope="col"
              :aria-sort="panel.full ? ariaSort(c.key) : undefined"
              :class="['px-4 py-2 font-medium', c.right ? 'text-right' : '']"
            >
              <button
                v-if="panel.full"
                type="button"
                class="inline-flex items-center gap-1 uppercase hover:text-text max-lg:min-h-11 max-lg:min-w-11"
                :data-testid="`sort-${c.key}`"
                @click="sortBy(c.key)"
              >
                {{ $t(`integrations.rabbitmq.panels.cols.${c.label}`) }}
                <component
                  :is="desc ? ArrowDown : ArrowUp"
                  v-if="sortKey === c.key"
                  class="size-3"
                  aria-hidden="true"
                />
              </button>
              <template v-else>{{ $t(`integrations.rabbitmq.panels.cols.${c.label}`) }}</template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in rows"
            :key="`${r.vhost}\u0000${r.queue}`"
            class="border-t border-border first:border-t-0"
            data-testid="queue-row"
            :data-queue="r.name"
          >
            <td class="max-w-[18rem] px-4 py-2">
              <div class="flex min-w-0 items-center gap-2">
                <span
                  class="size-2 shrink-0 rounded-full"
                  :style="{ background: `var(${SEVERITY_TOKEN[r.severity ?? 'ok']})` }"
                  aria-hidden="true"
                />
                <span v-if="r.severity && r.severity !== 'ok'" class="sr-only"
                  >{{ $t(`integrations.severity.${r.severity}`) }}:
                </span>
                <RouterLink
                  :to="queueRoute(page.appId, r.vhost, r.queue)"
                  class="truncate font-mono text-text hover:text-primary hover:underline max-lg:min-h-11 max-lg:leading-[2.75rem]"
                  :title="r.name"
                  >{{ r.name }}</RouterLink
                >
                <span v-if="r.type" class="shrink-0 text-12 text-text-subtle">{{ r.type }}</span>
              </div>
            </td>
            <td class="px-4 py-2">
              <div class="flex items-center gap-2">
                <span
                  class="w-16 shrink-0 text-right tabular-nums"
                  :class="SEVERITY_TEXT[r.severity ?? 'ok']"
                  >{{ r.ready.toLocaleString('en') }}</span
                >
                <span
                  class="h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-surface-3"
                  aria-hidden="true"
                >
                  <span
                    class="block h-full rounded-full"
                    :style="{
                      width: `${(r.ready / max) * 100}%`,
                      background: `var(${r.severity && r.severity !== 'ok' ? SEVERITY_TOKEN[r.severity] : '--chart-1'})`,
                    }"
                  />
                </span>
              </div>
            </td>
            <td class="px-4 py-2 text-right text-text-muted tabular-nums">
              {{ r.unacked.toLocaleString('en') }}
            </td>
            <td class="px-4 py-2 text-right text-text-muted tabular-nums">
              {{ r.in === null ? '–' : formatRate(r.in) }}
            </td>
            <td class="px-4 py-2 text-right text-text-muted tabular-nums">
              {{ r.out === null ? '–' : formatRate(r.out) }}
            </td>
            <td
              class="px-4 py-2 text-right tabular-nums"
              :class="
                r.consumers === 0 && r.type !== 'stream' && r.ready > 0
                  ? r.severity === 'critical'
                    ? 'font-semibold text-critical-text'
                    : 'text-warning-text'
                  : 'text-text-muted'
              "
            >
              {{ r.consumers ?? '–'
              }}<template v-if="r.consumers && r.busy !== null">
                ·
                {{
                  $t('integrations.rabbitmq.panels.cols.busyPct', { pct: Math.round(r.busy * 100) })
                }}</template
              >
            </td>
            <td
              class="px-4 py-2 text-right tabular-nums"
              :class="
                r.severity === 'critical'
                  ? 'font-semibold text-critical-text'
                  : r.drain.state === 'growing' || r.drain.state === 'never'
                    ? 'text-warning-text'
                    : 'text-text-muted'
              "
            >
              {{ drainText(r) ?? $t(`integrations.rabbitmq.panels.drain.${r.drain.state}`) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="panel.full && !rows.length" class="text-13 text-text-subtle" data-testid="queues-none">
      {{ $t('integrations.rabbitmq.panels.cols.noneMatch') }}
    </p>
    <RouterLink
      v-if="!panel.full"
      :to="{ name: 'application', params: { id: page.appId }, query: { tab: 'queues' } }"
      class="self-end text-13 text-primary hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
      data-testid="queues-all"
      >{{ $t('integrations.rabbitmq.panels.allQueuesLink', { n: panel.total }) }}</RouterLink
    >
  </div>
</template>
