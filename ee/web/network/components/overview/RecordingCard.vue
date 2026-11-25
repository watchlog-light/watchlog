<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { ChevronRight } from '@lucide/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatWhen } from '@/lib/format';
import type { RecordingLine } from '../../api';
import { bpsText } from '../../lib/format';

// The Overview's Recording card (ADR-234, Main board): one line per recorder, whether it is
// writing, since when it stopped and why, its cameras, the disk it writes to (a LUN on a NAS),
// the days of footage left and its write rate against its usual band. Each line opens Storage.
const props = defineProps<{ lines: RecordingLine[] }>();
const { t, locale } = useI18n();

type State = 'yes' | 'no' | 'unknown';
const stateOf = (r: RecordingLine): State =>
  r.recording === true ? 'yes' : r.recording === false ? 'no' : 'unknown';

const DOT: Record<State, string> = {
  yes: 'bg-ok',
  no: 'bg-critical',
  unknown: 'bg-text-subtle',
};
const TEXT: Record<State, string> = {
  yes: 'text-ok-text',
  no: 'text-critical-text',
  unknown: 'text-text-muted',
};

/** Bytes a second as bits: "38 Mb/s". */
const rateText = (bytes: number) => bpsText(bytes * 8);

const rows = computed(() =>
  props.lines.map((r) => {
    const state = stateOf(r);
    let headline: string;
    if (state === 'yes') headline = t('net.recording.yes');
    else if (state === 'no') {
      const since = r.since
        ? t('net.recording.noSince', { at: formatWhen(r.since, Date.now(), locale.value) })
        : t('net.recording.no');
      headline = r.why ? `${since} · ${r.why}` : since;
    } else {
      const why = r.why || (r.status !== 'ok' ? t(`net.status.${r.status}`) : '');
      headline = why ? `${t('net.recording.unknown')} · ${why}` : t('net.recording.unknown');
    }
    const usual = r.usual
      ? t('net.recording.usual', { low: rateText(r.usual.low), high: rateText(r.usual.high) })
      : '';
    return {
      r,
      state,
      headline,
      cameras: t('net.recording.cameras', { online: r.cameras.online, total: r.cameras.total }),
      camerasShort: r.cameras.online < r.cameras.total,
      disk: r.disk
        ? r.disk.nas
          ? t('net.recording.diskOn', { lun: r.disk.lun, nas: r.disk.nas })
          : r.disk.lun
        : '',
      left: r.full
        ? t('net.recording.full')
        : r.daysCalculating
          ? t('net.recording.calculating')
          : r.daysLeft != null
            ? t('net.recording.daysLeft', { n: Math.floor(r.daysLeft) }, Math.floor(r.daysLeft))
            : '',
      rate: r.rate != null ? rateText(r.rate) : '',
      slow: r.rate != null && !!r.usual && r.rate < r.usual.low,
      usual,
    };
  }),
);

const summary = computed(() => {
  const n = props.lines.length;
  const yes = props.lines.filter((r) => r.recording === true).length;
  const no = props.lines.filter((r) => r.recording === false).length;
  if (no) return { text: t('net.recording.summaryNo', { n: no }, no), tone: 'text-critical-text' };
  if (yes === n) return { text: t('net.recording.summaryAll', { n }, n), tone: 'text-ok-text' };
  return { text: t('net.recording.summarySome', { n: yes, of: n }), tone: 'text-text-muted' };
});
</script>

<template>
  <section
    class="flex flex-col rounded-card border border-border bg-surface-1"
    aria-labelledby="net-recording"
    data-testid="overview-recording"
  >
    <div
      class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3"
    >
      <h2 id="net-recording" class="text-14 font-semibold text-text">
        {{ $t('net.recording.title') }}
      </h2>
      <span class="text-13 font-semibold" :class="summary.tone">{{ summary.text }}</span>
    </div>
    <RouterLink
      v-for="row in rows"
      :key="row.r.id"
      :to="{ name: 'network-storage' }"
      class="flex items-center gap-3 border-t border-border px-4 py-2.5 first-of-type:border-t-0 hover:bg-surface-2 max-md:min-h-11"
      data-testid="recording-line"
      :data-recording="row.state"
    >
      <span class="size-2 shrink-0 rounded-full" :class="DOT[row.state]" aria-hidden="true" />
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span class="truncate font-mono text-13 font-medium text-text">{{ row.r.name }}</span>
          <span class="min-w-0 text-13" :class="TEXT[row.state]">{{ row.headline }}</span>
        </span>
        <span class="flex flex-wrap gap-x-2 text-12 text-text-muted">
          <span :class="row.camerasShort ? 'text-warning-text' : ''">{{ row.cameras }}</span>
          <span v-if="row.disk" class="min-w-0 truncate font-mono">· {{ row.disk }}</span>
          <span v-if="row.left" :class="row.r.full ? 'text-text' : ''">· {{ row.left }}</span>
        </span>
      </span>
      <span v-if="row.rate" class="flex shrink-0 flex-col items-end">
        <span
          class="font-mono text-13 tabular"
          :class="row.slow ? 'text-warning-text' : 'text-text'"
          >{{ row.rate }}</span
        >
        <span v-if="row.usual" class="text-12 text-text-subtle">{{ row.usual }}</span>
      </span>
      <ChevronRight class="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
    </RouterLink>
    <p class="border-t border-border px-4 py-2.5 text-12 text-text-subtle">
      {{ $t('net.recording.note') }}
    </p>
  </section>
</template>
