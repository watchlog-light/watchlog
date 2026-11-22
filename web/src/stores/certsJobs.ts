// SPDX-License-Identifier: AGPL-3.0-only
import type { CertificateList, ScheduledJobList } from '@watchlog/api-types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';

// The selected cluster's certificates and scheduled jobs (0.10, ADR-221), shared by the
// navigation's badges, the Overview's row, search and the two pages; read again after 30 s.
const FRESH_MS = 30_000;

export const useCertsJobsStore = defineStore('certsJobs', () => {
  const certs = ref<CertificateList | null>(null);
  const jobs = ref<ScheduledJobList | null>(null);
  const certsFor = ref<string | null>(null);
  const jobsFor = ref<string | null>(null);
  let certsAt = 0;
  let jobsAt = 0;

  async function loadCerts(clusterId: string, force = false): Promise<CertificateList> {
    if (!force && certs.value && certsFor.value === clusterId && Date.now() - certsAt < FRESH_MS)
      return certs.value;
    const res = await api<CertificateList>(`/clusters/${clusterId}/certificates`);
    certs.value = res;
    certsFor.value = clusterId;
    certsAt = Date.now();
    return res;
  }

  async function loadJobs(clusterId: string, force = false): Promise<ScheduledJobList> {
    if (!force && jobs.value && jobsFor.value === clusterId && Date.now() - jobsAt < FRESH_MS)
      return jobs.value;
    const res = await api<ScheduledJobList>(`/clusters/${clusterId}/scheduled-jobs`);
    jobs.value = res;
    jobsFor.value = clusterId;
    jobsAt = Date.now();
    return res;
  }

  function reset() {
    certs.value = jobs.value = null;
    certsFor.value = jobsFor.value = null;
    certsAt = jobsAt = 0;
  }

  return { certs, jobs, certsFor, jobsFor, loadCerts, loadJobs, reset };
});
