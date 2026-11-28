<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { formatValue } from '@/lib/units';
import { SEVERITY_DOT, SEVERITY_TEXT, type PanelOf } from '@/lib/panels';
import { statementRoute } from '@/lib/service-links';
import { useServicePage } from '@/lib/service-page';
import PanelLink from './PanelLink.vue';

// A database's statements (1.2, ADR-245, the design's "Queries that cost the most"): the
// normalised text opening the statement's page, calls a second, the mean (with an arrow when
// it is far slower than usual), the share of the time or of the active sessions, rows per
// call, the client that sends most of it when one clearly does, and a hint under the text
// ("probably missing an index on shop.events", "5× slower than usual").
const props = defineProps<{ panel: PanelOf<'statements'> }>();
const page = useServicePage();
const pct = (v: number | null) =>
  v === null ? '–' : `${v < 0.01 && v > 0 ? '<1' : Math.round(v * 100)}%`;
const rows = computed(() => props.panel.rows);
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="-mx-4 overflow-x-auto">
      <table class="w-full text-13" :class="panel.full ? 'min-w-[52rem]' : 'min-w-[40rem]'">
        <thead>
          <tr
            class="border-b border-border text-left text-11 font-medium tracking-wider whitespace-nowrap text-text-muted uppercase"
          >
            <th scope="col" class="px-4 py-2 font-medium">
              {{ $t('integrations.db.panels.cols.statement') }}
            </th>
            <th scope="col" class="px-2 py-2 text-right font-medium">
              {{ $t('integrations.db.panels.cols.callsPerSecond') }}
            </th>
            <th scope="col" class="px-2 py-2 text-right font-medium">
              {{ $t('integrations.db.panels.cols.mean') }}
            </th>
            <th scope="col" class="px-2 py-2 text-right font-medium">
              {{
                $t(
                  panel.shareOf === 'waits'
                    ? 'integrations.db.panels.cols.shareOfWaits'
                    : 'integrations.db.panels.cols.shareOfTime',
                )
              }}
            </th>
            <th scope="col" class="px-2 py-2 text-right font-medium">
              {{ $t('integrations.db.panels.cols.rowsPerCall') }}
            </th>
            <th scope="col" class="px-4 py-2 font-medium">
              {{ $t('integrations.db.panels.cols.sentBy') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in rows"
            :key="r.id"
            class="border-t border-border align-top first:border-t-0"
            data-testid="statement-row"
          >
            <td class="max-w-[30rem] px-4 py-2">
              <div class="flex min-w-0 items-center gap-2">
                <span
                  class="size-2 shrink-0 rounded-full"
                  :class="r.severity ? SEVERITY_DOT[r.severity] : 'bg-ok'"
                  aria-hidden="true"
                ></span>
                <span v-if="r.severity && r.severity !== 'ok'" class="sr-only"
                  >{{ $t(`integrations.severity.${r.severity}`) }}:
                </span>
                <RouterLink
                  :to="statementRoute(page.appId, r.id)"
                  class="min-w-0 truncate font-mono text-text hover:text-primary hover:underline max-lg:min-h-11 max-lg:py-3"
                  :title="r.text"
                  data-testid="statement-link"
                  >{{ r.text }}</RouterLink
                >
              </div>
              <p
                v-if="r.hint"
                class="mt-1 pl-4 text-12"
                :class="r.severity ? SEVERITY_TEXT[r.severity] : 'text-text-muted'"
                data-testid="statement-hint"
              >
                {{ $t(r.hint.key, r.hint.values ?? {}) }}
              </p>
            </td>
            <td class="px-2 py-2 text-right text-text tabular-nums">
              {{ r.calls === null ? '–' : formatValue(r.calls, 'per_second') }}
            </td>
            <td
              class="px-2 py-2 text-right tabular-nums"
              :class="
                r.hint?.key.endsWith('.slower') ? 'font-semibold text-warning-text' : 'text-text'
              "
              :title="
                r.usual !== null
                  ? $t('integrations.db.panels.usualMean', {
                      mean: formatValue(r.usual, 'seconds'),
                    })
                  : undefined
              "
            >
              {{ r.mean === null ? '–' : formatValue(r.mean, 'seconds')
              }}{{ r.hint?.key.endsWith('.slower') ? ' ↑' : '' }}
            </td>
            <td class="px-2 py-2 text-right text-text tabular-nums">{{ pct(r.share) }}</td>
            <td class="px-2 py-2 text-right text-text tabular-nums">
              {{ r.rows === null ? '–' : formatValue(r.rows, 'count') }}
            </td>
            <td class="px-4 py-2">
              <template v-if="r.sentBy">
                <PanelLink v-if="r.sentBy.link" :link="r.sentBy.link">{{
                  r.sentBy.name
                }}</PanelLink>
                <span v-else class="text-text">{{ r.sentBy.name }}</span>
              </template>
              <span v-else class="text-text-subtle">–</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <RouterLink
      v-if="!panel.full && panel.total > rows.length"
      :to="{ name: 'application', params: { id: page.appId }, query: { tab: 'queries' } }"
      class="self-end text-13 font-semibold text-primary hover:underline max-lg:min-h-11 max-lg:py-3"
      data-testid="statements-all"
      >{{ $t('integrations.db.panels.allStatements', { n: panel.total }, panel.total) }}</RouterLink
    >
  </div>
</template>
