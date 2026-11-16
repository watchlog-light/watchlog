<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { RotateCcw } from '@lucide/vue';
import type { AlertDetail, AnomalyAlert, AnomalyFeedback } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import CausePanel from '@/components/causes/CausePanel.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useLoader } from '@/composables/useLoader';
import { heroGeometry, localHourWords } from '@/lib/anomaly';
import { formatDateTime } from '@/lib/format';
import {
  hhmm,
  isProFeature,
  metricText,
  objectName,
  rangeText,
  valueText,
} from '@/lib/what-changed';
import { useAuthStore } from '@/stores/auth';
import WhatChangedAlertCard from './WhatChangedAlertCard.vue';
import WhatChangedCauseCard from './WhatChangedCauseCard.vue';

// An anomaly alert's page (ADR-200, the screen Anomaly): the hero (now, the usual range at this
// hour, the series against each hour's usual band), the "What changed around it" card, the
// probable cause, and "Was this worth an alert?". Owners and Admins answer; Viewers read the
// answer. Kubernetes and Docker name the subject in their own words (the backend's object).
const props = defineProps<{ alert: AlertDetail['alert'] }>();
const { t, locale } = useI18n();
const auth = useAuthStore();
const canManage = auth.canManage;
const tr = (key: string, values?: Record<string, unknown>) => t(key, values ?? {});

const locked = ref(false);
const page = useLoader(async () => {
  try {
    return await api<AnomalyAlert>(`/alerts/${props.alert.id}/anomaly`);
  } catch (err) {
    // Without What changed (a downgrade), or the period is gone: the page as for any rule.
    if (isProFeature(err) || (err instanceof ApiError && err.status === 404)) {
      locked.value = true;
      return null;
    }
    throw err;
  }
});
const a = computed(() => page.data.value ?? null);
const feedback = ref<AnomalyFeedback | null | undefined>(undefined);
const answer = computed(() =>
  feedback.value === undefined ? (a.value?.feedback ?? null) : feedback.value,
);

const W = 1000;
const H = 200;
const geo = computed(() => (a.value ? heroGeometry(a.value, W, H, locale.value) : null));
// The bucket in the viewer's local time, as the dashboard labels buckets (ADR-196).
const when = computed(() =>
  localHourWords(a.value?.since ?? new Date(0).toISOString(), locale.value),
);
const metric = computed(() => (a.value ? metricText(a.value, tr) : ''));
const who = computed(() => (a.value ? objectName(a.value.object) : ''));
const open = computed(() => !!a.value && !a.value.until && a.value.alert.state !== 'resolved');
const stateLine = computed(() => {
  if (!a.value) return '';
  return open.value
    ? t('anomaly.hero.firingSince', { time: hhmm(a.value.since, locale.value) })
    : t('anomaly.hero.ended', {
        time: hhmm(a.value.until ?? a.value.alert.resolvedAt ?? a.value.since, locale.value),
      });
});
const widened = computed(() => {
  const f = answer.value;
  if (!a.value || !f || f.widenedLow === undefined || f.widenedHigh === undefined) return '?';
  return rangeText(f.widenedLow, f.widenedHigh, a.value.unit);
});

const busy = ref(false);
const failed = ref(false);
async function give(value: 'useful' | 'normal') {
  busy.value = true;
  failed.value = false;
  try {
    const r = await api<{ feedback: AnomalyFeedback }>(
      `/alerts/${props.alert.id}/anomaly-feedback`,
      { method: 'POST', body: { answer: value } },
    );
    feedback.value = r.feedback;
  } catch {
    failed.value = true;
  } finally {
    busy.value = false;
  }
}
async function undo() {
  busy.value = true;
  failed.value = false;
  try {
    await api(`/alerts/${props.alert.id}/anomaly-feedback`, { method: 'DELETE' });
    feedback.value = null;
  } catch {
    failed.value = true;
  } finally {
    busy.value = false;
  }
}

onMounted(() => void page.load());
</script>

<template>
  <template v-if="locked">
    <CausePanel :cluster-id="alert.cluster.id" :subject="`alert:${alert.id}`" />
    <WhatChangedAlertCard :alert="alert" />
  </template>

  <div v-else class="flex flex-col">
    <!-- The hero: the series against its usual band. -->
    <section class="an-card flex flex-col gap-5.5 p-7 max-md:p-4.5" data-testid="anomaly-hero">
      <div v-if="!a" class="flex flex-col gap-4" aria-busy="true">
        <Skeleton shape="rect" class="h-5 w-2/3" />
        <Skeleton shape="rect" class="h-14 w-1/3" />
        <Skeleton shape="rect" class="h-50 w-full" />
      </div>
      <template v-else>
        <div
          class="flex flex-wrap justify-between gap-x-4 gap-y-1 font-mono text-13 tracking-widest uppercase"
        >
          <h3 class="font-normal text-text" data-testid="anomaly-when">
            {{ $t('anomaly.hero.title', { day: when.day, hour: when.hour }) }}
          </h3>
          <span class="text-text-subtle" data-testid="anomaly-what">{{ who }} · {{ metric }}</span>
        </div>

        <div class="flex flex-wrap items-end gap-x-10 gap-y-3.5">
          <div class="flex flex-col gap-1">
            <span class="font-mono text-13 tracking-wider text-text-subtle uppercase">{{
              $t(open ? 'anomaly.hero.now' : 'anomaly.hero.peak')
            }}</span>
            <span class="an-now text-warning" data-testid="anomaly-now">{{
              valueText(a.value, a.unit)
            }}</span>
          </div>
          <div class="flex flex-col gap-1 pb-1.5">
            <span class="font-mono text-13 tracking-wider text-text-subtle uppercase">{{
              $t('anomaly.hero.usual')
            }}</span>
            <span class="an-usual text-text-muted" data-testid="anomaly-usual">{{
              rangeText(a.usualLow, a.usualHigh, a.unit)
            }}</span>
          </div>
          <div class="ml-auto flex flex-wrap gap-2 pb-2 max-md:ml-0">
            <span class="an-pill an-pill-warn">{{ $t(`alerts.severity.${alert.severity}`) }}</span>
            <span class="an-pill an-pill-plain" data-testid="anomaly-state">{{ stateLine }}</span>
            <span class="an-pill an-pill-pro">{{ $t('whatChanged.pro') }}</span>
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <svg
            v-if="geo && !geo.empty"
            class="h-50 w-full"
            :viewBox="`0 0 ${W} ${H}`"
            preserveAspectRatio="none"
            role="img"
            :aria-label="
              $t('anomaly.hero.chartLabel', {
                metric,
                usual: rangeText(a.usualLow, a.usualHigh, a.unit),
                value: valueText(a.value, a.unit),
              })
            "
            data-testid="anomaly-chart"
          >
            <polygon v-if="geo.band" :points="geo.band" class="an-band" />
            <rect
              v-if="geo.unusual"
              :x="geo.unusual.x"
              y="6"
              :width="geo.unusual.width"
              :height="H - 12"
              rx="6"
              class="an-zone"
              vector-effect="non-scaling-stroke"
            />
            <polyline
              v-if="geo.before"
              :points="geo.before"
              class="an-line"
              vector-effect="non-scaling-stroke"
            />
            <polyline
              v-if="geo.after"
              :points="geo.after"
              class="an-spike"
              vector-effect="non-scaling-stroke"
            />
          </svg>
          <p v-else class="text-13 text-text-muted">{{ $t('anomaly.hero.noSeries') }}</p>
          <div
            v-if="geo && !geo.empty"
            class="relative h-4 font-mono text-12 text-text-subtle"
            aria-hidden="true"
          >
            <span
              v-for="tk in geo.ticks"
              :key="tk.label + tk.at"
              class="absolute -translate-x-1/2"
              :style="{ left: `${tk.at * 100}%` }"
              >{{ tk.label }}</span
            >
          </div>
          <div class="flex flex-wrap gap-x-5 gap-y-1 text-13 text-text-muted">
            <span class="flex items-center gap-2"
              ><span class="an-swatch-band" aria-hidden="true"></span
              >{{ $t('anomaly.hero.legendBand', { day: when.day }) }}</span
            >
            <span class="flex items-center gap-2"
              ><span class="an-swatch-line" aria-hidden="true"></span
              >{{ $t('anomaly.hero.legendLine') }}</span
            >
          </div>
        </div>
      </template>
    </section>

    <div class="flex justify-center" aria-hidden="true"><span class="an-connector"></span></div>

    <div class="flex flex-col gap-5">
      <WhatChangedAlertCard :alert="alert" />
      <WhatChangedCauseCard
        :cluster-id="alert.cluster.id"
        :cluster-name="alert.cluster.name"
        :subject="`alert:${alert.id}`"
        :platform="alert.cluster.kind === 'docker' ? 'docker' : 'kubernetes'"
      />

      <div class="flex flex-wrap gap-5">
        <!-- "Was this worth an alert?" (ADR-200). -->
        <section
          class="an-card flex min-w-0 flex-[1_1_420px] flex-col gap-3.5 p-6 max-md:p-4.5"
          aria-labelledby="an-fb-title"
          data-testid="anomaly-feedback"
        >
          <h3 id="an-fb-title" class="font-mono text-13 tracking-widest text-text uppercase">
            {{ $t('anomaly.feedback.title') }}
          </h3>
          <template v-if="a && answer">
            <p class="text-14 text-text" data-testid="anomaly-feedback-answer">
              {{
                answer.answer === 'normal'
                  ? $t('anomaly.feedback.normalDone', {
                      day: when.day,
                      hour: when.hour,
                      range: widened,
                    })
                  : $t('anomaly.feedback.usefulDone')
              }}
            </p>
            <p class="text-13 text-text-muted" data-testid="anomaly-feedback-by">
              {{
                $t(
                  answer.answer === 'normal'
                    ? 'anomaly.feedback.widenedBy'
                    : 'anomaly.feedback.answeredBy',
                  {
                    date: formatDateTime(answer.at),
                    name: answer.by ?? $t('anomaly.feedback.someone'),
                  },
                )
              }}
            </p>
            <div v-if="canManage">
              <button
                type="button"
                class="an-ghost"
                :disabled="busy"
                data-testid="anomaly-feedback-undo"
                @click="undo"
              >
                <RotateCcw class="size-4" aria-hidden="true" />{{ $t('anomaly.feedback.undo') }}
              </button>
            </div>
          </template>
          <template v-else>
            <div v-if="canManage" class="flex flex-wrap gap-2.5">
              <button
                type="button"
                class="an-ghost"
                :disabled="busy || !a"
                data-testid="anomaly-feedback-yes"
                @click="give('useful')"
              >
                {{ $t('anomaly.feedback.yes') }}
              </button>
              <button
                type="button"
                class="an-ghost"
                :disabled="busy || !a"
                data-testid="anomaly-feedback-no"
                @click="give('normal')"
              >
                {{ $t('anomaly.feedback.no') }}
              </button>
            </div>
            <p class="text-14 text-text-muted" data-testid="anomaly-feedback-hint">
              {{ $t(canManage ? 'anomaly.feedback.hint' : 'anomaly.feedback.viewer') }}
            </p>
          </template>
          <p v-if="failed" class="text-13 text-critical" role="alert">
            {{ $t('anomaly.feedback.failed') }}
          </p>
        </section>

        <!-- The words every channel got: the alert's title and why (ADR-200's message). -->
        <section
          class="an-card flex min-w-0 flex-[1_1_420px] flex-col gap-3.5 p-6 max-md:p-4.5"
          aria-labelledby="an-msg-title"
          data-testid="anomaly-message"
        >
          <h3 id="an-msg-title" class="font-mono text-13 tracking-widest text-text uppercase">
            {{ $t('anomaly.message.title') }}
          </h3>
          <p class="an-msg whitespace-pre-line text-text-muted">
            {{ [alert.title, alert.why].filter(Boolean).join('\n') }}
          </p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.an-card {
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface-1);
}
.an-now {
  font-size: 56px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.an-usual {
  font-size: 26px;
}
.an-msg {
  font-size: 15px;
  line-height: 1.6;
}
@media (max-width: 767px) {
  .an-now {
    font-size: 44px;
  }
  .an-usual {
    font-size: 22px;
  }
}
.an-pill {
  border-radius: 999px;
  padding: 4px 11px;
  font-size: 13px;
  font-weight: 600;
}
.an-pill-warn {
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  color: var(--warning);
}
.an-pill-plain {
  background: var(--surface-2);
  color: var(--text);
}
.an-pill-pro {
  border: 1px solid color-mix(in srgb, var(--info) 50%, transparent);
  color: var(--info);
}
.an-band {
  fill: color-mix(in srgb, var(--text-muted) 13%, transparent);
}
.an-zone {
  fill: color-mix(in srgb, var(--warning) 6%, transparent);
  stroke: var(--warning);
  stroke-width: 1.5;
  stroke-dasharray: 5 5;
}
.an-line {
  fill: none;
  stroke: var(--ok);
  stroke-width: 2.5;
  stroke-linejoin: round;
}
.an-spike {
  fill: none;
  stroke: var(--warning);
  stroke-width: 3;
  stroke-linejoin: round;
}
.an-swatch-band {
  width: 18px;
  height: 10px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--text-muted) 30%, transparent);
}
.an-swatch-line {
  width: 18px;
  height: 3px;
  border-radius: 2px;
  background: var(--ok);
}
.an-connector {
  width: 1px;
  height: 56px;
  background: var(--warning);
}
.an-ghost {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 0 16px;
  font-size: 14px;
  color: var(--text-muted);
  background: transparent;
}
.an-ghost:hover:not(:disabled) {
  color: var(--text);
  background: var(--surface-2);
}
.an-ghost:disabled {
  opacity: 0.6;
}
.an-ghost:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
</style>
