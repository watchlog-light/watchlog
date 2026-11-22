<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CalendarClock, ShieldCheck } from '@lucide/vue';
import { computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import OverviewCard from '@/components/overview/OverviewCard.vue';
import {
  CERT_TONE,
  JOB_TONE,
  certDays,
  certNeedsAttention,
  jobName,
  jobNeedsAttention,
  jobProblem,
  type Tone,
  type Words,
} from '@/lib/certs-jobs';
import { useCertsJobsStore } from '@/stores/certsJobs';

// Certificates and scheduled jobs at a glance (0.10): on a server's page for that server (the
// Overview has the "Running here" row since 0.13.0). Counts, the problems (three of each) and
// links to the two pages and each one's page.
const props = defineProps<{ clusterId: string; node?: string }>();
const { t } = useI18n();
const store = useCertsJobsStore();

function load() {
  void store.loadCerts(props.clusterId).catch(() => undefined);
  void store.loadJobs(props.clusterId).catch(() => undefined);
}
onMounted(load);
watch(() => props.clusterId, load);

const mine = <T extends { node: string }>(list: T[] | undefined) =>
  (list ?? []).filter((x) => props.node === undefined || x.node === props.node);
const certs = computed(() =>
  store.certsFor === props.clusterId ? mine(store.certs?.certificates) : null,
);
const jobs = computed(() => (store.jobsFor === props.clusterId ? mine(store.jobs?.jobs) : null));
const certProblems = computed(() => (certs.value ?? []).filter(certNeedsAttention));
const jobProblems = computed(() => (jobs.value ?? []).filter(jobNeedsAttention));
const loading = computed(() => certs.value === null && jobs.value === null);
const say = (w: Words) => t(w.key, w.values ?? {}, Number(w.values?.n ?? 1));
const TEXT: Record<Tone, string> = {
  crit: 'text-critical-text',
  warn: 'text-warning-text',
  ok: 'text-text-muted',
  info: 'text-info-text',
  muted: 'text-text-muted',
};
const nodeQuery = (node: string) => (node ? { node } : {});
</script>

<template>
  <OverviewCard :title="$t('certsJobsCard.title')" :loading="loading" testid="certs-jobs-card">
    <div class="flex flex-col divide-y divide-border">
      <div class="flex flex-col gap-2 px-3.5 py-3">
        <RouterLink
          :to="{ name: 'certificates' }"
          class="flex items-center gap-2 text-14 text-text hover:underline max-lg:min-h-11"
          data-testid="certs-summary"
        >
          <ShieldCheck class="size-4 text-text-muted" aria-hidden="true" />
          {{ $t('certsJobsCard.certs', { n: certs?.length ?? 0 }, certs?.length ?? 0) }}
          <span :class="certProblems.length ? 'text-warning-text' : 'text-text-muted'">
            ·
            {{
              certProblems.length
                ? $t('certsJobsCard.attention', { n: certProblems.length }, certProblems.length)
                : $t('certsJobsCard.allFine')
            }}</span
          >
        </RouterLink>
        <ul v-if="certProblems.length" class="flex flex-col gap-1">
          <li v-for="c in certProblems.slice(0, 3)" :key="`${c.node}/${c.id}`" class="text-13">
            <RouterLink
              :to="{ name: 'certificate', params: { certId: c.id }, query: nodeQuery(c.node) }"
              class="flex flex-wrap items-center gap-x-1.5 hover:underline max-lg:min-h-11"
            >
              <span class="font-mono text-text">{{ c.names[0] }}</span>
              <span :class="TEXT[CERT_TONE[c.status]]">{{
                c.status === 'problem' ? $t('certs.status.problem') : say(certDays(c))
              }}</span>
              <span v-if="c.node && node === undefined" class="text-text-muted"
                >· {{ c.node }}</span
              >
            </RouterLink>
          </li>
        </ul>
      </div>
      <div class="flex flex-col gap-2 px-3.5 py-3">
        <RouterLink
          :to="{ name: 'scheduled-jobs' }"
          class="flex items-center gap-2 text-14 text-text hover:underline max-lg:min-h-11"
          data-testid="jobs-summary"
        >
          <CalendarClock class="size-4 text-text-muted" aria-hidden="true" />
          {{ $t('certsJobsCard.jobs', { n: jobs?.length ?? 0 }, jobs?.length ?? 0) }}
          <span :class="jobProblems.length ? 'text-warning-text' : 'text-text-muted'">
            ·
            {{
              jobProblems.length
                ? $t('certsJobsCard.attention', { n: jobProblems.length }, jobProblems.length)
                : $t('certsJobsCard.allFine')
            }}</span
          >
        </RouterLink>
        <ul v-if="jobProblems.length" class="flex flex-col gap-1">
          <li v-for="j in jobProblems.slice(0, 3)" :key="`${j.node}/${j.id}`" class="text-13">
            <RouterLink
              :to="{ name: 'scheduled-job', params: { jobId: j.id }, query: nodeQuery(j.node) }"
              class="flex flex-wrap items-center gap-x-1.5 hover:underline max-lg:min-h-11"
            >
              <span class="font-mono text-text">{{ jobName(j).name }}</span>
              <span :class="TEXT[JOB_TONE[j.state] ?? 'muted']">{{
                say(jobProblem(j).words)
              }}</span>
              <span v-if="j.node && node === undefined" class="text-text-muted"
                >· {{ j.node }}</span
              >
            </RouterLink>
          </li>
        </ul>
      </div>
    </div>
  </OverviewCard>
</template>
