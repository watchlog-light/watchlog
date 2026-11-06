<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { BellOff, Repeat } from '@lucide/vue';
import type { Alert } from '@watchlog/api-types';
import TonePill from '@/components/kube/TonePill.vue';
import { alertWhere, duration, severityTone, stateTone } from '@/lib/alerts';
import { since } from '@/lib/time';
import { useNarrow } from '@/composables/useNarrow';

// Firing alerts (what, where, since when) or resolved ones with how long they lasted
// (SPEC §4.7). Severity and state always carry an icon and a label.
defineProps<{ alerts: Alert[]; history?: boolean; canSilence?: boolean }>();
defineEmits<{ silence: [alert: Alert] }>();
// Phones: one card per alert instead of the five-column table.
const narrow = useNarrow();
</script>

<template>
  <ul
    v-if="narrow"
    class="overflow-hidden rounded-card border border-border bg-surface-1"
    data-testid="alert-table"
  >
    <li
      v-for="a in alerts"
      :key="a.id"
      class="flex flex-col gap-1.5 border-t border-border px-4 py-3 first:border-t-0"
      data-testid="alert-row"
    >
      <div class="flex flex-wrap items-center gap-1.5">
        <TonePill :tone="severityTone(a.severity)" :label="$t(`alerts.severity.${a.severity}`)" />
        <TonePill :tone="stateTone(a)" :label="$t(`alerts.state.${a.state}`)" />
        <span class="ml-auto font-mono text-12 whitespace-nowrap text-text-muted tabular">
          <span class="sr-only"
            >{{ history ? $t('alerts.columns.lasted') : $t('alerts.columns.since') }}:
          </span>
          {{
            history && a.resolvedAt
              ? duration(a.firedAt ?? a.startedAt, a.resolvedAt)
              : since(a.startedAt)
          }}
        </span>
      </div>
      <RouterLink
        :to="{ name: 'alert', params: { id: a.id } }"
        class="flex min-h-11 items-center font-medium break-words text-text hover:underline"
      >
        {{ a.title }}
      </RouterLink>
      <p class="text-12 break-words text-text-muted">{{ alertWhere(a) }} · {{ a.cluster.name }}</p>
      <p v-if="a.why" class="text-12 break-words text-text-muted">{{ a.why }}</p>
      <p v-if="a.silenced || a.flapping" class="flex flex-wrap gap-3 text-12 text-text-muted">
        <span v-if="a.silenced" class="inline-flex items-center gap-1" data-testid="silenced">
          <BellOff class="size-3.5" aria-hidden="true" />{{ $t('alerts.silenced') }}
        </span>
        <span v-if="a.flapping" class="inline-flex items-center gap-1">
          <Repeat class="size-3.5" aria-hidden="true" />{{ $t('alerts.flapping') }}
        </span>
      </p>
      <button
        v-if="canSilence && !history && !a.silenced"
        type="button"
        class="h-11 self-start rounded-control border border-border-strong px-3.5 text-13 font-medium text-text hover:bg-surface-2"
        data-testid="silence-alert"
        @click="$emit('silence', a)"
      >
        {{ $t('alerts.silence.action') }}
      </button>
    </li>
  </ul>
  <div v-else class="overflow-x-auto rounded-card border border-border bg-surface-1">
    <table class="w-full min-w-[820px] text-left text-13" data-testid="alert-table">
      <thead class="bg-surface-2 text-12 text-text-muted">
        <tr>
          <th class="px-4 py-2 font-medium">{{ $t('alerts.columns.severity') }}</th>
          <th class="px-4 py-2 font-medium">{{ $t('alerts.columns.alert') }}</th>
          <th class="px-4 py-2 font-medium">{{ $t('alerts.columns.state') }}</th>
          <th class="px-4 py-2 text-right font-medium">
            {{ history ? $t('alerts.columns.lasted') : $t('alerts.columns.since') }}
          </th>
          <th v-if="canSilence && !history" class="px-4 py-2" />
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="a in alerts"
          :key="a.id"
          class="border-t border-border align-top"
          data-testid="alert-row"
        >
          <td class="px-4 py-2.5">
            <TonePill
              :tone="severityTone(a.severity)"
              :label="$t(`alerts.severity.${a.severity}`)"
            />
          </td>
          <td class="max-w-[28rem] px-4 py-2.5">
            <RouterLink
              :to="{ name: 'alert', params: { id: a.id } }"
              class="block truncate font-medium text-text hover:underline max-lg:leading-11"
            >
              {{ a.title }}
            </RouterLink>
            <p class="truncate text-12 text-text-muted">
              {{ alertWhere(a) }} · {{ a.cluster.name }}
            </p>
            <p v-if="a.why" class="truncate text-12 text-text-muted">{{ a.why }}</p>
          </td>
          <td class="px-4 py-2.5">
            <div class="flex flex-wrap gap-1.5">
              <TonePill :tone="stateTone(a)" :label="$t(`alerts.state.${a.state}`)" />
              <span
                v-if="a.silenced"
                class="inline-flex items-center gap-1 text-12 text-text-muted"
                data-testid="silenced"
              >
                <BellOff class="size-3.5" aria-hidden="true" />{{ $t('alerts.silenced') }}
              </span>
              <span
                v-if="a.flapping"
                class="inline-flex items-center gap-1 text-12 text-text-muted"
              >
                <Repeat class="size-3.5" aria-hidden="true" />{{ $t('alerts.flapping') }}
              </span>
            </div>
          </td>
          <td class="px-4 py-2.5 text-right font-mono whitespace-nowrap tabular">
            {{
              history && a.resolvedAt
                ? duration(a.firedAt ?? a.startedAt, a.resolvedAt)
                : since(a.startedAt)
            }}
          </td>
          <td v-if="canSilence && !history" class="px-4 py-2.5 text-right">
            <button
              v-if="!a.silenced"
              type="button"
              class="text-12 font-medium text-text-muted hover:text-text max-lg:h-11 max-lg:px-2"
              data-testid="silence-alert"
              @click="$emit('silence', a)"
            >
              {{ $t('alerts.silence.action') }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
