<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { KubeEvent } from '@watchlog/api-types';
import { computed, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import {
  dayOf,
  groupTitle,
  lastSeenOf,
  objectLink,
  objectName,
  shortKind,
  trimIds,
  type EventItem,
} from '@/lib/events';
import { formatDateTime } from '@/lib/format';
import { EVENT_HINTS } from '@/lib/overview';
import { clockTime, since } from '@/lib/time';

// The event list (ADR-111): day separators; a row per
// event or group with its time, reason, object, message (IDs trimmed) and count; a fix
// hint for well-known reasons. A click opens a row: a group's members, or an event's
// full message and times.
const props = defineProps<{ items: EventItem[]; nodes?: number }>();
const { t } = useI18n();
const open = reactive(new Set<string>());
const toggle = (k: string) => (open.has(k) ? open.delete(k) : open.add(k));
const fmt = new Intl.NumberFormat('en');
const dayFormat = new Intl.DateTimeFormat('en', {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
});

const rows = computed(() => {
  const out: ({ type: 'day'; key: string; label: string } | EventItem)[] = [];
  let last = '';
  for (const it of props.items) {
    const d = dayOf(lastSeenOf(it));
    if (d.key !== last) {
      out.push({
        type: 'day',
        key: `day:${d.key}`,
        label: d.label ? t(`kube.events.days.${d.label}`) : dayFormat.format(d.date),
      });
      last = d.key;
    }
    out.push(it);
  }
  return out;
});
const time = (iso: string) => clockTime(iso).slice(0, 5);
const hint = (reason: string) =>
  EVENT_HINTS.has(reason) ? t(`overview.events.hints.${reason}`) : null;
const isWarning = (type: string) => type === 'Warning';
const groupMessage = (events: KubeEvent[]) => {
  const names = [...new Set(events.map((e) => e.involvedName))];
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
  return `${shown} · ${trimIds(events[0]!.message)}`;
};
</script>

<template>
  <section class="feed" data-testid="event-feed">
    <template v-for="r in rows" :key="r.key">
      <div v-if="r.type === 'day'" class="day" data-testid="day">{{ r.label }}</div>

      <template v-else-if="r.type === 'event'">
        <div
          class="er"
          :class="{ open: open.has(r.key) }"
          role="button"
          tabindex="0"
          :aria-expanded="open.has(r.key)"
          data-testid="event-row"
          @click="toggle(r.key)"
          @keydown.enter.prevent="toggle(r.key)"
          @keydown.space.prevent="toggle(r.key)"
        >
          <span class="tm">{{ time(r.event.lastSeen) }}</span>
          <span class="rs" :class="isWarning(r.event.type) ? 'w' : 'n'"
            >{{ isWarning(r.event.type) ? '▲' : '○' }} {{ r.event.reason }}</span
          >
          <div class="min-w-0">
            <div class="o">
              {{ shortKind(r.event.involvedKind) }}
              <RouterLink
                v-if="objectLink(r.event)"
                :to="objectLink(r.event)!"
                class="font-medium hover:underline"
                data-testid="event-object"
                @click.stop
                >{{ objectName(r.event) }}</RouterLink
              >
              <b v-else class="font-medium" data-testid="event-object">{{ objectName(r.event) }}</b>
              <span v-if="r.event.host" class="text-text-subtle">{{
                ` ${$t('kube.events.onHost', { host: r.event.host })}`
              }}</span>
            </div>
            <div class="m" data-testid="event-message">{{ trimIds(r.event.message) }}</div>
            <div v-if="hint(r.event.reason)" class="hint" data-testid="event-hint">
              {{ hint(r.event.reason) }}
            </div>
          </div>
          <span class="c"
            >{{ fmt.format(r.event.count) }}×<br />{{
              $t('overview.events.ago', { t: since(r.event.lastSeen) })
            }}</span
          >
        </div>
        <div v-if="open.has(r.key)" class="sub" data-testid="event-detail">
          <p class="full">{{ r.event.message }}</p>
          <p>
            {{
              $t('kube.events.seen', {
                first: formatDateTime(r.event.firstSeen),
                last: formatDateTime(r.event.lastSeen),
              })
            }}
            <template v-if="r.event.reportingController">
              · {{ $t('kube.events.reporter', { r: r.event.reportingController }) }}</template
            >
          </p>
        </div>
      </template>

      <template v-else>
        <div
          class="er grp"
          :class="{ open: open.has(r.key) }"
          role="button"
          tabindex="0"
          :aria-expanded="open.has(r.key)"
          data-testid="event-group"
          @click="toggle(r.key)"
          @keydown.enter.prevent="toggle(r.key)"
          @keydown.space.prevent="toggle(r.key)"
        >
          <span class="tm">{{ time(r.lastSeen) }}</span>
          <span class="rs" :class="isWarning(r.eventType) ? 'w' : 'n'"
            >{{ isWarning(r.eventType) ? '▲' : '○' }}
            {{ r.routine ? $t('kube.events.group.routineReason') : r.reason }}</span
          >
          <div class="min-w-0">
            <div class="o">
              <span class="chev" aria-hidden="true">{{ open.has(r.key) ? '▾' : '▸' }}</span>
              {{ groupTitle(r, t, nodes) }}
            </div>
            <div class="m">
              {{
                r.routine
                  ? $t('kube.events.group.routineDetail', {
                      reasons: [...new Set(r.events.map((e) => e.reason))].join(', '),
                      n: r.count,
                    })
                  : groupMessage(r.events)
              }}
            </div>
            <div v-if="!r.routine && hint(r.reason)" class="hint">{{ hint(r.reason) }}</div>
          </div>
          <span class="c"
            >{{ fmt.format(r.count) }}×<br />{{
              $t('overview.events.ago', { t: since(r.lastSeen) })
            }}</span
          >
        </div>
        <div v-if="open.has(r.key)" class="sub" data-testid="group-members">
          <div
            v-for="e in r.events"
            :key="`${objectName(e)}/${e.reason}/${e.lastSeen}`"
            class="mem"
          >
            <span>{{ time(e.lastSeen) }}</span>
            <span class="truncate"
              >{{ shortKind(e.involvedKind) }}
              <RouterLink v-if="objectLink(e)" :to="objectLink(e)!" class="hover:underline">{{
                objectName(e)
              }}</RouterLink
              ><template v-else>{{ objectName(e) }}</template></span
            >
            <span>{{ fmt.format(e.count) }}×</span>
            <span class="truncate" :title="e.message">{{ e.message }}</span>
          </div>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.feed {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-1);
}
.day {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-subtle);
  font-size: 12px;
}
.er {
  display: grid;
  grid-template-columns: 52px auto minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.er:hover,
.er.open {
  background: color-mix(in srgb, var(--text) 2%, transparent);
}
.er:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}
.tm {
  padding-top: 1px;
  color: var(--text-subtle);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
}
.rs {
  padding: 1px 7px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.rs.w {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
}
.rs.n {
  color: var(--text-muted);
  background: var(--surface-3);
}
.o {
  font-size: 13px;
}
.chev {
  color: var(--text-subtle);
}
.m {
  margin-top: 2px;
  overflow-wrap: anywhere;
  color: var(--text-subtle);
  font-size: 12px;
}
.hint {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 12px;
}
.c {
  color: var(--text-subtle);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
.sub {
  padding: 6px 14px 10px 78px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-muted);
  font-size: 12px;
}
.sub .full {
  overflow-wrap: anywhere;
  font-family: var(--font-mono, ui-monospace, monospace);
}
.mem {
  display: grid;
  grid-template-columns: 44px minmax(0, 1.2fr) 60px minmax(0, 2fr);
  gap: 10px;
  padding: 3px 0;
  font-family: var(--font-mono, ui-monospace, monospace);
}
@media (max-width: 640px) {
  .er {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .er .tm,
  .er .c {
    display: none;
  }
  .sub {
    padding-left: 14px;
  }
}
</style>
