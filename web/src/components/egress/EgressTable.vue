<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { EgressRow } from '@watchlog/api-types';
import { formatBytes } from '@watchlog/cause-words';
import { useI18n } from 'vue-i18n';
import { ago, firstSeenText, percent, sourceLink, sourceName } from '@/lib/egress';
import EgressBadges from './EgressBadges.vue';

// The Egress page's destinations (ADR-188): a table from 768 px, one card per destination
// on phones. Names are text (from DNS answers, ADR-129), never links.
const props = defineProps<{ rows: EgressRow[]; clusterId: string; now?: number }>();
const { t } = useI18n();
const at = () => props.now ?? Date.now();
const dest = (r: EgressRow) => (r.class === 'internet' ? t('egress.internetRow') : r.destination);
const bytes = (r: EgressRow) =>
  r.sent === null || r.received === null
    ? '–'
    : `${formatBytes(r.sent)} / ${formatBytes(r.received)}`;
const conns = (r: EgressRow) => (r.connections === null ? '–' : r.connections.toLocaleString('en'));
const isNew = (r: EgressRow) => r.badges.includes('new');
const failing = (r: EgressRow) => r.badges.includes('failing');
</script>

<template>
  <div>
    <div
      class="hidden overflow-x-auto rounded-card border border-border bg-surface-1 md:block"
      data-testid="egress-table"
    >
      <table class="w-full min-w-[880px] border-collapse text-14">
        <thead>
          <tr class="text-left text-12 text-text-subtle">
            <th class="border-b border-border px-4 py-2.5 font-medium">
              {{ $t('egress.col.destination') }}
            </th>
            <th class="border-b border-border px-4 py-2.5 font-medium">
              {{ $t('egress.col.from') }}
            </th>
            <th class="border-b border-border px-4 py-2.5 font-medium">
              {{ $t('egress.col.firstSeen') }}
            </th>
            <th class="border-b border-border px-4 py-2.5 font-medium">
              {{ $t('egress.col.lastSeen') }}
            </th>
            <th class="border-b border-border px-4 py-2.5 font-medium">
              {{ $t('egress.col.bytes') }}
            </th>
            <th class="border-b border-border px-4 py-2.5 text-right font-medium">
              {{ $t('egress.col.connections') }}
            </th>
            <th class="border-b border-border px-4 py-2.5 text-right font-medium">
              {{ $t('egress.col.failed') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in rows"
            :key="`${r.destination}:${r.port}`"
            class="align-top hover:bg-surface-2"
            data-testid="egress-row"
          >
            <td class="border-b border-border px-4 py-3">
              <div class="flex flex-col gap-1.5">
                <span class="break-all font-mono text-13 text-text"
                  >{{ dest(r)
                  }}<span v-if="r.port" class="text-text-muted">:{{ r.port }}</span></span
                >
                <EgressBadges :row="r" />
              </div>
            </td>
            <td class="border-b border-border px-4 py-3">
              <ul class="flex flex-col gap-0.5">
                <li v-for="s in r.sources" :key="sourceName(s)">
                  <RouterLink
                    :to="sourceLink(s, clusterId)"
                    class="text-text hover:text-primary hover:underline"
                    >{{ sourceName(s) }}</RouterLink
                  >
                  <span v-if="s.new && r.sources.length > 1" class="ml-1.5 text-12 text-warning">{{
                    $t('egress.newSource')
                  }}</span>
                </li>
              </ul>
            </td>
            <td
              :class="[
                'border-b border-border px-4 py-3 whitespace-nowrap',
                isNew(r) ? 'font-semibold text-warning' : 'text-text-muted',
              ]"
            >
              {{ firstSeenText(r, t, at()) }}
            </td>
            <td class="border-b border-border px-4 py-3 whitespace-nowrap text-text-muted">
              {{ ago(r.lastSeen, t, at()) }}
            </td>
            <td class="border-b border-border px-4 py-3 font-mono text-13 whitespace-nowrap">
              {{ bytes(r) }}
            </td>
            <td class="border-b border-border px-4 py-3 text-right font-mono text-13">
              {{ conns(r) }}
            </td>
            <td
              :class="[
                'border-b border-border px-4 py-3 text-right font-mono text-13',
                failing(r) ? 'font-semibold text-critical' : 'text-text',
              ]"
            >
              {{ percent(r.failedRatio) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Phones (ADR-188): one card per destination. -->
    <ul class="flex flex-col gap-2.5 md:hidden" data-testid="egress-cards">
      <li
        v-for="r in rows"
        :key="`${r.destination}:${r.port}`"
        class="flex flex-col gap-2 rounded-card border border-border bg-surface-1 p-4"
        data-testid="egress-card"
      >
        <span class="break-all font-mono text-13 text-text"
          >{{ dest(r) }}<span v-if="r.port" class="text-text-muted">:{{ r.port }}</span></span
        >
        <EgressBadges :row="r" />
        <p class="text-13 text-text">
          <template v-for="(s, i) in r.sources" :key="sourceName(s)"
            ><span v-if="i">, </span
            ><RouterLink
              :to="sourceLink(s, clusterId)"
              class="hover:text-primary hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
              >{{ sourceName(s) }}</RouterLink
            ></template
          >
        </p>
        <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-12">
          <dt class="text-text-subtle">{{ $t('egress.col.firstSeen') }}</dt>
          <dd :class="isNew(r) ? 'font-semibold text-warning' : 'text-text-muted'">
            {{ firstSeenText(r, t, at()) }}
          </dd>
          <dt class="text-text-subtle">{{ $t('egress.col.lastSeen') }}</dt>
          <dd class="text-text-muted">{{ ago(r.lastSeen, t, at()) }}</dd>
          <dt class="text-text-subtle">{{ $t('egress.col.bytes') }}</dt>
          <dd class="font-mono text-text">{{ bytes(r) }}</dd>
          <dt class="text-text-subtle">{{ $t('egress.col.connections') }}</dt>
          <dd class="font-mono text-text">
            {{ conns(r) }} ·
            <span :class="failing(r) ? 'font-semibold text-critical' : ''">{{
              $t('egress.failedShort', { p: percent(r.failedRatio) })
            }}</span>
          </dd>
        </dl>
      </li>
    </ul>
  </div>
</template>
