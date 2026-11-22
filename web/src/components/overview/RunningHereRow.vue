<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CalendarClock, Database, ShieldCheck } from '@lucide/vue';
import type { Application, ScheduledJob, TlsCertificate } from '@watchlog/api-types';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import AgentUpdateDialog from '@/components/agents/AgentUpdateDialog.vue';
import RunBars from '@/components/applications/RunBars.vue';
import ExpiryTimeline from '@/components/certs/ExpiryTimeline.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { reasonLine, reasonText } from '@/lib/applications';
import {
  CERT_TONE,
  JOB_TONE,
  certDays,
  certTiles,
  jobName,
  type Tone,
  type Words,
} from '@/lib/certs-jobs';
import { formatDateTime } from '@/lib/format';
import {
  ROWS,
  certHeader,
  certLine,
  jobHeader,
  jobLine,
  serviceProblem,
  servicesHere,
  soonestCerts,
  topJobs,
} from '@/lib/running-here';
import { useApplicationsStore } from '@/stores/applications';
import { useCertsJobsStore } from '@/stores/certsJobs';

// "Running here" (0.13.0, ADR-230): under the tiles, what the agents found on their own —
// Services, Certificates (the 90-day strip, then the three soonest) and Scheduled jobs (12 small
// run bars each) — in the cluster's or fleet's words. Skeletons while loading; an empty card says
// how they are found and names older agents. Three columns, stacked on a narrow page.
const props = defineProps<{ clusterId: string; kind: 'kubernetes' | 'server' }>();
const { t } = useI18n();
const apps = useApplicationsStore();
const store = useCertsJobsStore();
const appsFailed = ref(false);

function load() {
  void apps.load().catch(() => (appsFailed.value = true));
  void store.loadCerts(props.clusterId).catch(() => undefined);
  void store.loadJobs(props.clusterId).catch(() => undefined);
}
onMounted(load);
watch(() => props.clusterId, load);

const kube = computed(() => props.kind === 'kubernetes');
const services = computed(() =>
  apps.loaded ? servicesHere(apps.list, props.clusterId) : appsFailed.value ? [] : null,
);
const certData = computed(() => (store.certsFor === props.clusterId ? store.certs : null));
const jobData = computed(() => (store.jobsFor === props.clusterId ? store.jobs : null));
const certs = computed<TlsCertificate[] | null>(() => certData.value?.certificates ?? null);
const jobs = computed<ScheduledJob[] | null>(() => jobData.value?.jobs ?? null);
const older = computed(() => {
  const seen = new Map<string, string>();
  for (const a of [
    ...(certData.value?.agentsWithout ?? []),
    ...(jobData.value?.agentsWithout ?? []),
  ])
    seen.set(a.node, a.version);
  return [...seen.keys()];
});
const updateOpen = ref(false);

const say = (w: Words) => t(w.key, w.values ?? {}, Number(w.values?.n ?? 1));
const sayAll = (ws: Words[]) => ws.map(say).join(' · ');
const TEXT: Record<Tone, string> = {
  crit: 'text-critical-text',
  warn: 'text-warning-text',
  ok: 'text-text-muted',
  info: 'text-info-text',
  muted: 'text-text-muted',
};
const DOT: Record<Tone, string> = {
  crit: 'bg-critical',
  warn: 'bg-warning',
  ok: 'bg-ok',
  info: 'bg-info',
  muted: 'bg-text-subtle',
};

// Services.
const svcProblems = computed(() => (services.value ?? []).filter(serviceProblem).length);
const SVC_TONE: Record<Application['health'], Tone> = {
  critical: 'crit',
  warning: 'warn',
  ok: 'ok',
  unknown: 'muted',
};
const svcLine = (a: Application) =>
  a.health === 'ok'
    ? [
        a.where.host && a.cluster.kind === 'server' ? a.where.host : null,
        a.where.group,
        a.where.address,
      ]
        .filter(Boolean)
        .join(' · ') || t('runningHere.services.ok')
    : sayReason(
        a.finding
          ? reasonLine(a.finding, a.cluster, (iso) => formatDateTime(iso))
          : reasonText(a, (iso) => formatDateTime(iso)),
      );
function sayReason(r: { key: string; values: Record<string, unknown> }) {
  return t(r.key, r.values);
}

// Certificates.
const certHead = computed(() => (certs.value ? certHeader(certs.value) : null));
const certRows = computed(() => soonestCerts(certs.value ?? []));
const renewing = computed(() => certTiles(certs.value ?? []).renewing);
const certLink = (c: TlsCertificate) => ({
  name: 'certificate',
  params: { certId: c.id },
  query: c.node ? { node: c.node } : {},
});

// Scheduled jobs.
const jobHead = computed(() => (jobs.value ? jobHeader(jobs.value) : null));
const jobRows = computed(() => topJobs(jobs.value ?? []));
const lastDay = computed(() => jobData.value?.lastDay ?? { runs: 0, failures: 0 });
const jobLink = (j: ScheduledJob) => ({
  name: 'scheduled-job',
  params: { jobId: j.id },
  query: j.node ? { node: j.node } : {},
});
const runsLabel = (j: ScheduledJob) => {
  const recent = j.recent.slice(0, 12);
  if (recent.length === 0) return t('runningHere.jobs.noRuns');
  const ok = recent.filter((r) => r.result === 'success').length;
  const failed = recent.filter((r) => r.result === 'failed').length;
  return t(
    'runningHere.jobs.runsLabel',
    { n: recent.length, summary: t('jobs.runsSummary', { ok, failed }) },
    recent.length,
  );
};
const jobTitle = (j: ScheduledJob) => (j.node ? jobName(j).name : j.name);
</script>

<template>
  <section
    aria-labelledby="running-here-h"
    class="flex flex-col gap-2.5"
    data-testid="running-here"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 id="running-here-h" class="text-16 font-semibold text-text">
        {{ $t('runningHere.title') }}
      </h2>
      <span class="text-13 text-text-muted">{{ $t('runningHere.sub') }}</span>
    </div>
    <div class="row">
      <!-- Services -->
      <div
        class="flex min-w-0 flex-col rounded-card border border-border bg-surface-1"
        data-testid="running-services"
      >
        <RouterLink
          :to="{ name: 'applications' }"
          class="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5 hover:underline max-lg:min-h-11"
        >
          <Database class="size-5 text-text-muted" aria-hidden="true" />
          <span class="flex-1 text-15 font-semibold text-text">{{
            $t('runningHere.services.title')
          }}</span>
          <span v-if="services" class="text-13 text-text-muted" data-testid="running-count"
            >{{ services.length
            }}<template v-if="svcProblems">
              ·
              <b class="font-semibold text-critical-text">{{
                $t('runningHere.services.problems', { n: svcProblems }, svcProblems)
              }}</b></template
            ></span
          >
        </RouterLink>
        <div
          v-if="!services"
          class="flex flex-col gap-2 px-4 pb-3"
          :aria-label="$t('runningHere.loading')"
          role="status"
        >
          <Skeleton v-for="i in ROWS" :key="i" shape="rect" class="h-9 w-full" />
        </div>
        <div
          v-else-if="services.length === 0"
          class="flex flex-col gap-1 border-t border-border px-4 py-3.5"
        >
          <p class="text-14 text-text">{{ $t('runningHere.services.none') }}</p>
          <p class="text-13 text-text-muted">{{ $t('runningHere.services.noneHint') }}</p>
        </div>
        <template v-else>
          <RouterLink
            v-for="a in services.slice(0, ROWS)"
            :key="a.id"
            :to="{ name: 'application', params: { id: a.id } }"
            class="flex items-center gap-2.5 border-t border-border px-4 py-2.25 hover:bg-surface-2 max-lg:min-h-11"
            data-testid="running-row"
          >
            <span
              :class="['size-2 shrink-0 rounded-full', DOT[SVC_TONE[a.health]]]"
              aria-hidden="true"
            />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-mono text-13 text-text">{{ a.name }}</span>
              <span :class="['truncate text-12', TEXT[SVC_TONE[a.health]]]">{{ svcLine(a) }}</span>
            </span>
          </RouterLink>
        </template>
        <RouterLink
          :to="{ name: 'applications' }"
          class="mt-auto border-t border-border px-4 py-2.5 text-13 font-medium text-link hover:underline max-lg:min-h-11"
        >
          {{
            services && services.length
              ? $t('runningHere.services.all', { n: services.length })
              : $t('runningHere.services.find')
          }}
          →
        </RouterLink>
      </div>

      <!-- Certificates -->
      <div
        class="flex min-w-0 flex-col rounded-card border border-border bg-surface-1"
        data-testid="running-certificates"
      >
        <RouterLink
          :to="{ name: 'certificates' }"
          class="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5 hover:underline max-lg:min-h-11"
        >
          <ShieldCheck class="size-5 text-text-muted" aria-hidden="true" />
          <span class="flex-1 text-15 font-semibold text-text">{{
            $t('runningHere.certs.title')
          }}</span>
          <span v-if="certs" class="text-13 text-text-muted" data-testid="running-count"
            >{{ certs.length
            }}<template v-if="certHead">
              ·
              <b :class="['font-semibold', TEXT[certHead.tone]]">{{
                say(certHead.words)
              }}</b></template
            ></span
          >
        </RouterLink>
        <div
          v-if="!certs"
          class="flex flex-col gap-2 px-4 pb-3"
          :aria-label="$t('runningHere.loading')"
          role="status"
        >
          <Skeleton shape="rect" class="h-7 w-full" />
          <Skeleton v-for="i in ROWS" :key="i" shape="rect" class="h-9 w-full" />
        </div>
        <div
          v-else-if="certs.length === 0"
          class="flex flex-col gap-1 border-t border-border px-4 py-3.5"
          data-testid="running-empty"
        >
          <p class="text-14 text-text">{{ $t('runningHere.certs.none') }}</p>
          <p class="text-13 text-text-muted">
            {{ kube ? $t('runningHere.certs.noneKube') : $t('runningHere.certs.noneServer') }}
          </p>
        </div>
        <template v-else>
          <div class="px-4 pt-1 pb-3">
            <ExpiryTimeline :certs="certs" variant="strip" />
          </div>
          <RouterLink
            v-for="c in certRows"
            :key="`${c.node}/${c.id}`"
            :to="certLink(c)"
            class="flex items-center gap-2.5 border-t border-border px-4 py-2.25 hover:bg-surface-2 max-lg:min-h-11"
            data-testid="running-row"
          >
            <span
              :class="['size-2 shrink-0 rounded-full', DOT[CERT_TONE[c.status]]]"
              aria-hidden="true"
            />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-mono text-13 text-text">{{ c.names[0] }}</span>
              <span
                :class="['truncate text-12', TEXT[certLine(c).tone]]"
                data-testid="running-line"
                >{{ sayAll(certLine(c).words) }}</span
              >
            </span>
            <span
              :class="[
                'shrink-0 font-mono text-13 whitespace-nowrap',
                CERT_TONE[c.status] === 'ok'
                  ? 'text-text-muted'
                  : ['font-semibold', TEXT[CERT_TONE[c.status]]],
              ]"
              >{{ say(certDays(c)) }}</span
            >
          </RouterLink>
        </template>
        <p
          v-if="older.length && certs"
          class="border-t border-border px-4 py-2.5 text-13 text-text-muted"
          data-testid="running-older"
        >
          {{
            kube
              ? $t('runningHere.olderAgent')
              : $t('runningHere.olderAgents', { names: older.slice(0, 3).join(', ') }, older.length)
          }}
          <button type="button" class="text-link hover:underline" @click="updateOpen = true">
            {{ $t('runningHere.updateAgents') }}
          </button>
        </p>
        <RouterLink
          :to="{ name: 'certificates' }"
          class="mt-auto border-t border-border px-4 py-2.5 text-13 font-medium text-link hover:underline max-lg:min-h-11"
        >
          {{
            certs && certs.length
              ? renewing
                ? $t('runningHere.certs.all', { n: certs.length, renewing })
                : $t('runningHere.certs.allPlain', { n: certs.length })
              : $t('runningHere.certs.title')
          }}
          →
        </RouterLink>
      </div>

      <!-- Scheduled jobs -->
      <div
        class="flex min-w-0 flex-col rounded-card border border-border bg-surface-1"
        data-testid="running-jobs"
      >
        <RouterLink
          :to="{ name: 'scheduled-jobs' }"
          class="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5 hover:underline max-lg:min-h-11"
        >
          <CalendarClock class="size-5 text-text-muted" aria-hidden="true" />
          <span class="flex-1 text-15 font-semibold text-text">{{
            $t('runningHere.jobs.title')
          }}</span>
          <span v-if="jobs" class="text-13 text-text-muted" data-testid="running-count"
            >{{ jobs.length
            }}<template v-if="jobHead">
              ·
              <b :class="['font-semibold', TEXT[jobHead.tone]]">{{
                say(jobHead.words)
              }}</b></template
            ></span
          >
        </RouterLink>
        <div
          v-if="!jobs"
          class="flex flex-col gap-2 px-4 pb-3"
          :aria-label="$t('runningHere.loading')"
          role="status"
        >
          <Skeleton v-for="i in ROWS" :key="i" shape="rect" class="h-9 w-full" />
        </div>
        <div
          v-else-if="jobs.length === 0"
          class="flex flex-col gap-1 border-t border-border px-4 py-3.5"
          data-testid="running-empty"
        >
          <p class="text-14 text-text">{{ $t('runningHere.jobs.none') }}</p>
          <p class="text-13 text-text-muted">
            {{ kube ? $t('runningHere.jobs.noneKube') : $t('runningHere.jobs.noneServer') }}
          </p>
        </div>
        <template v-else>
          <RouterLink
            v-for="j in jobRows"
            :key="`${j.node}/${j.id}`"
            :to="jobLink(j)"
            class="flex items-center gap-2.5 border-t border-border px-4 py-2.25 hover:bg-surface-2 max-lg:min-h-11"
            data-testid="running-row"
          >
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-mono text-13 text-text"
                >{{ jobTitle(j)
                }}<span v-if="j.node && jobLine(j).tone !== 'muted'" class="text-text-muted">
                  · {{ j.node }}</span
                ></span
              >
              <span
                :class="[
                  'truncate text-12',
                  TEXT[jobLine(j).tone] ?? TEXT[JOB_TONE[j.state] ?? 'muted'],
                ]"
                data-testid="running-line"
                >{{ sayAll(jobLine(j).words) }}</span
              >
            </span>
            <RunBars
              class="shrink-0"
              :runs="j.recent"
              :usual="j.usualSeconds"
              :slots="12"
              :label="runsLabel(j)"
            />
          </RouterLink>
        </template>
        <p
          v-if="older.length && jobs && !certs"
          class="border-t border-border px-4 py-2.5 text-13 text-text-muted"
        >
          {{
            kube
              ? $t('runningHere.olderAgent')
              : $t('runningHere.olderAgents', { names: older.slice(0, 3).join(', ') }, older.length)
          }}
        </p>
        <RouterLink
          :to="{ name: 'scheduled-jobs' }"
          class="mt-auto border-t border-border px-4 py-2.5 text-13 font-medium text-link hover:underline max-lg:min-h-11"
        >
          {{
            jobs && jobs.length
              ? lastDay.runs > 0
                ? $t('runningHere.jobs.all', {
                    n: jobs.length,
                    ok: (lastDay.runs - lastDay.failures).toLocaleString('en'),
                    total: lastDay.runs.toLocaleString('en'),
                  })
                : $t('runningHere.jobs.allNoRuns', { n: jobs.length })
              : $t('runningHere.jobs.title')
          }}
          →
        </RouterLink>
      </div>
    </div>
    <AgentUpdateDialog v-if="older.length" v-model:open="updateOpen" :cluster-id="clusterId" />
  </section>
</template>

<style scoped>
/* Three columns while each gets 300 px, else one: the page's width, not the window's. */
.row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
}
</style>
