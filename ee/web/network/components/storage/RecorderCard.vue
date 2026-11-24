<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed } from 'vue';
import { formatBytes } from '@/lib/units';
import { since } from '@/lib/time';
import type { RecorderCard } from '../../api';
import { bpsText } from '../../lib/format';
import {
  daysLeftWords,
  rateAgainstUsual,
  recordingState,
  signalState,
  usedShare,
} from '../../lib/storage';

// One recorder (ADR-234): is it recording, its three signals (the recorder, its iSCSI disk, the
// writes toward the NAS) with why, its cameras, its disk and the days of footage left, the write
// rate against its usual, and the place that polls it.
const props = defineProps<{ r: RecorderCard }>();

const state = computed(() => recordingState(props.r));
const STATE = {
  yes: { pill: 'bg-ok/15 text-ok-text', border: 'border-ok/40' },
  no: { pill: 'bg-critical/15 text-critical-text', border: 'border-critical/60' },
  unknown: { pill: 'bg-surface-3 text-text-muted', border: 'border-border' },
} as const;
const unknownWhy = computed(() =>
  props.r.status !== 'ok' && props.r.status !== 'pending' ? 'notAnswering' : 'notKnown',
);

const DOT = { true: 'bg-ok', false: 'bg-critical', unknown: 'bg-text-subtle' } as const;
const SIG_KEY = { true: 'fine', false: 'failing', unknown: 'unknown' } as const;
const SIGNAL_TEXT = {
  true: 'text-text-muted',
  false: 'text-critical-text',
  unknown: 'text-text-muted',
} as const;

const days = computed(() => daysLeftWords(props.r));
const share = computed(() => usedShare(props.r.total, props.r.free));
const against = computed(() => rateAgainstUsual(props.r.rate, props.r.usual));
const bits = (v: number) => bpsText(v * 8);
const offline = computed(() => props.r.cameras.list.filter((c) => !c.online).length);
const linkedDisks = computed(() => props.r.disks.filter((d) => d.iscsi));
</script>

<template>
  <article
    class="flex min-w-0 flex-col gap-4 rounded-card border bg-surface-1 p-4"
    :class="STATE[state].border"
    data-testid="recording-card"
    :data-recording="state"
    :data-recorder="r.name"
  >
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 flex-col">
        <RouterLink
          :to="{ name: 'network-device', params: { id: r.id } }"
          class="inline-flex items-center font-mono text-16 text-text hover:underline max-md:min-h-11 max-md:min-w-11"
          >{{ r.name }}</RouterLink
        >
        <span class="text-12 text-text-muted">{{
          [r.model, r.address].filter(Boolean).join(' · ')
        }}</span>
      </div>
      <div class="flex flex-col items-end gap-1 max-sm:items-start">
        <span
          class="inline-flex h-8 items-center rounded-full px-3 text-14 font-semibold"
          :class="STATE[state].pill"
          >{{ $t(`netStorage.recording.state.${state}`) }}</span
        >
        <span v-if="state === 'no' && r.since" class="text-12 text-critical-text">{{
          $t('netStorage.recording.sinceAgo', { t: since(r.since) })
        }}</span>
        <span v-else-if="state === 'unknown'" class="text-12 text-text-muted">{{
          $t(`netStorage.recording.${unknownWhy}`, {
            status: $t(`netWifi.status.${r.status}`),
          })
        }}</span>
      </div>
    </header>

    <ol class="flex flex-col gap-1.5">
      <li
        v-for="(s, i) in r.signals"
        :key="s.key"
        class="flex items-start gap-3 rounded-control border border-border bg-surface-2 px-3 py-2"
        :data-testid="`recording-signal-${s.key}`"
        :data-ok="signalState(s)"
      >
        <span class="w-4 shrink-0 font-mono text-12 text-text-subtle">{{ i + 1 }}</span>
        <span
          class="mt-1.5 size-2 shrink-0 rounded-full"
          :class="DOT[signalState(s)]"
          aria-hidden="true"
        />
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="text-13 font-medium text-text">
            {{ $t(`netStorage.recording.signal.${s.key}`) }}
            <span class="font-normal" :class="SIGNAL_TEXT[signalState(s)]">
              · {{ $t(`netStorage.recording.signalState.${SIG_KEY[signalState(s)]}`) }}
            </span>
          </span>
          <span
            v-if="s.why || (s.ok === false && s.since)"
            class="text-12"
            :class="SIGNAL_TEXT[signalState(s)]"
            >{{ s.why
            }}<template v-if="s.ok === false && s.since">
              · {{ $t('netStorage.recording.sinceAgo', { t: since(s.since) }) }}</template
            ></span
          >
        </span>
      </li>
    </ol>

    <dl class="grid grid-cols-3 gap-3 max-md:grid-cols-1">
      <div class="flex flex-col gap-0.5">
        <dt class="text-12 text-text-muted">{{ $t('netStorage.recording.cameras') }}</dt>
        <dd class="font-mono text-16 tabular" :class="offline ? 'text-warning-text' : 'text-text'">
          {{
            r.cameras.total
              ? $t('netStorage.recording.ofTotal', { n: r.cameras.online, of: r.cameras.total })
              : '–'
          }}
        </dd>
        <dd v-if="r.cameras.total" class="text-12 text-text-subtle">
          {{
            offline
              ? $t('netStorage.recording.camerasOffline', { n: offline }, offline)
              : $t('netStorage.recording.camerasAllOnline')
          }}
        </dd>
      </div>
      <div class="flex flex-col gap-0.5">
        <dt class="text-12 text-text-muted">{{ $t('netStorage.recording.disk') }}</dt>
        <dd class="font-mono text-16 tabular text-text">
          {{
            r.total
              ? $t('netStorage.recording.freeOf', {
                  free: formatBytes(r.free),
                  total: formatBytes(r.total),
                })
              : '–'
          }}
        </dd>
        <dd
          class="text-12"
          :class="days.key === 'full' ? 'text-warning-text' : 'text-text-subtle'"
          data-testid="recording-days-left"
          :data-full="r.full"
        >
          {{ $t(`netStorage.daysLeft.${days.key}`, { n: days.n }, days.n) }}
        </dd>
        <dd v-if="share != null" class="mt-1 h-1.5 rounded-full bg-surface-3" aria-hidden="true">
          <span
            class="block h-1.5 rounded-full"
            :class="r.full ? 'bg-warning' : 'bg-info'"
            :style="{ width: `${Math.round(share * 100)}%` }"
          />
        </dd>
      </div>
      <div class="flex flex-col gap-0.5">
        <dt class="text-12 text-text-muted">{{ $t('netStorage.recording.rate') }}</dt>
        <dd
          class="font-mono text-16 tabular"
          :class="against === 'below' ? 'text-warning-text' : 'text-text'"
        >
          {{ r.rate == null ? '–' : bits(r.rate) }}
        </dd>
        <dd class="text-12 text-text-subtle">
          {{
            r.usual
              ? $t('netStorage.recording.usual', {
                  low: bits(r.usual.low),
                  high: bits(r.usual.high),
                })
              : $t('netStorage.recording.usualLearning')
          }}
        </dd>
        <dd v-if="r.rateFrom" class="font-mono text-12 text-text-subtle">
          {{
            $t('netStorage.recording.rateFrom', {
              device: r.rateFrom.device,
              port: r.rateFrom.port,
            })
          }}
        </dd>
      </div>
    </dl>

    <ul v-if="linkedDisks.length" class="flex flex-col gap-1 text-12 text-text-muted">
      <li v-for="d in linkedDisks" :key="d.name" class="flex flex-wrap items-center gap-x-1.5">
        <span
          class="size-1.5 rounded-full"
          :class="d.healthy ? 'bg-ok' : 'bg-critical'"
          aria-hidden="true"
        />
        <span class="font-mono text-text">{{ d.name }}</span>
        <template v-if="d.session">
          ·
          {{ $t('netStorage.recording.lunOn', { lun: d.session.lun, nas: d.session.nas ?? '–' }) }}
        </template>
        <template v-else> · {{ $t('netStorage.recording.noSession') }}</template>
        <span v-if="d.state">· {{ d.state }}</span>
      </li>
    </ul>

    <details
      v-if="r.cameras.list.length"
      class="group rounded-control border border-border"
      :open="offline > 0 && r.cameras.list.length <= 16"
      data-testid="camera-list"
    >
      <summary
        class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-13 text-text max-md:min-h-11"
      >
        {{ $t('netStorage.recording.cameraList', { n: r.cameras.total }, r.cameras.total) }}
        <span class="text-12 text-text-subtle group-open:hidden">{{ $t('netStorage.show') }}</span>
        <span class="hidden text-12 text-text-subtle group-open:inline">{{
          $t('netStorage.hide')
        }}</span>
      </summary>
      <ul class="max-h-80 overflow-y-auto border-t border-border">
        <li
          v-for="c in r.cameras.list"
          :key="c.channel"
          class="grid grid-cols-[3rem_1fr_auto] items-center gap-2 border-t border-border px-3 py-1.5 text-13 first:border-t-0"
          data-testid="camera-row"
          :data-online="c.online"
        >
          <span class="font-mono text-12 text-text-subtle">{{
            $t('netStorage.recording.channel', { n: c.channel + 1 })
          }}</span>
          <span class="truncate text-text">{{ c.name || '–' }}</span>
          <span
            class="inline-flex items-center gap-1.5 text-12 whitespace-nowrap"
            :class="c.online ? 'text-text-muted' : 'text-critical-text'"
          >
            <span
              class="size-1.5 rounded-full"
              :class="c.online ? 'bg-ok' : 'bg-critical'"
              aria-hidden="true"
            />
            {{ c.online ? $t('netStorage.online') : $t('netStorage.offline')
            }}<template v-if="c.since"> · {{ since(c.since) }}</template>
          </span>
        </li>
      </ul>
    </details>

    <p class="text-12 text-text-subtle">
      {{
        $t(r.poller.kind === 'kubernetes' ? 'netStorage.polledNode' : 'netStorage.polledServer', {
          place: r.poller.name,
          host: r.poller.host || '–',
        })
      }}
    </p>
  </article>
</template>
