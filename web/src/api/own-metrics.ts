// SPDX-License-Identifier: AGPL-3.0-only
// The API of "Your metrics" (1.0.0, ADR-236), per cluster or fleet.
import type {
  OwnAlertInput,
  OwnAlertList,
  OwnAlertPreview,
  OwnDashboard,
  OwnDashboardList,
  OwnFound,
  OwnMetric,
  OwnMetricDetail,
  OwnMetricList,
  OwnMetricSeries,
  OwnMetricsSummary,
  OwnNewToken,
  OwnOwner,
  OwnPins,
  OwnWidgetInput,
} from '@watchlog/api-types';
import { api } from '@/api/client';
import { ownerQuery, type OwnType, type OwnUnit } from '@/lib/own-metrics';

const base = (cluster: string) => `/clusters/${cluster}/own-metrics`;

export interface SeriesOptions {
  from: number;
  to: number;
  step?: number;
  by?: string;
  stat?: 'p50' | 'p95' | 'p99';
  owner?: OwnOwner;
}

export type NewSource =
  | { server: string; address: string }
  | { namespace: string; workloadKind: string; workload: string; port: number; path?: string };

export const ownMetricsApi = {
  summary: (cluster: string) => api<OwnMetricsSummary>(base(cluster)),
  metrics: (cluster: string, o: { all?: boolean; spark?: boolean; owner?: OwnOwner } = {}) => {
    const q = new URLSearchParams(o.owner ? ownerQuery(o.owner) : '');
    if (o.all) q.set('all', 'true');
    if (o.spark) q.set('spark', 'true');
    const s = q.toString();
    return api<OwnMetricList>(`${base(cluster)}/metrics${s ? `?${s}` : ''}`);
  },
  metric: (cluster: string, id: string) => api<OwnMetricDetail>(`${base(cluster)}/metrics/${id}`),
  series: (cluster: string, id: string, o: SeriesOptions) => {
    const q = new URLSearchParams(o.owner ? ownerQuery(o.owner) : '');
    q.set('from', String(o.from));
    q.set('to', String(o.to));
    if (o.step) q.set('step', String(o.step));
    if (o.by) q.set('by', o.by);
    if (o.stat) q.set('stat', o.stat);
    return api<OwnMetricSeries>(`${base(cluster)}/metrics/${id}/series?${q.toString()}`);
  },
  correct: (
    cluster: string,
    id: string,
    body: { type?: OwnType | null; unit?: OwnUnit | null; checkAgain?: true },
  ) => api<{ metric: OwnMetric }>(`${base(cluster)}/metrics/${id}`, { method: 'PATCH', body }),
  pins: (cluster: string, owner: OwnOwner) =>
    api<OwnPins>(`${base(cluster)}/pins?${ownerQuery(owner)}`),
  pin: (cluster: string, metricId: string, owner: OwnOwner) =>
    api<{ id: string }>(`${base(cluster)}/pins`, {
      method: 'POST',
      body: {
        metricId,
        owner:
          owner.kind === 'server'
            ? { kind: 'server', name: owner.name }
            : {
                kind: 'workload',
                namespace: owner.namespace,
                workloadKind: owner.workloadKind,
                name: owner.name,
              },
      },
    }),
  unpin: (cluster: string, pinId: string) =>
    api<void>(`${base(cluster)}/pins/${pinId}`, { method: 'DELETE' }),
  createToken: (cluster: string, name: string) =>
    api<OwnNewToken>(`${base(cluster)}/tokens`, { method: 'POST', body: { name } }),
  revokeToken: (cluster: string, id: string) =>
    api<void>(`${base(cluster)}/tokens/${id}`, { method: 'DELETE' }),
  addSource: (cluster: string, body: NewSource) =>
    api<{ id: string }>(`${base(cluster)}/sources`, { method: 'POST', body }),
  removeSource: (cluster: string, id: string) =>
    api<void>(`${base(cluster)}/sources/${id}`, { method: 'DELETE' }),
  settings: (cluster: string, prometheusAnnotations: boolean) =>
    api<{ prometheusAnnotations: boolean }>(`${base(cluster)}/settings`, {
      method: 'PUT',
      body: { prometheusAnnotations },
    }),
  watch: (cluster: string, id: string, watched: boolean) =>
    api<{ watched: boolean }>(`${base(cluster)}/metrics/${id}/watch`, {
      method: 'PUT',
      body: { watched },
    }),
  alerts: (cluster: string) => api<OwnAlertList>(`${base(cluster)}/alerts`),
  alertPreview: (cluster: string, body: OwnAlertInput) =>
    api<OwnAlertPreview>(`${base(cluster)}/alerts/preview`, { method: 'POST', body }),
  createAlert: (cluster: string, body: OwnAlertInput) =>
    api<{ id: string; name: string }>(`${base(cluster)}/alerts`, { method: 'POST', body }),
  deleteAlert: (cluster: string, id: string) =>
    api<void>(`${base(cluster)}/alerts/${id}`, { method: 'DELETE' }),
  find: (cluster: string) => api<OwnFound>(`${base(cluster)}/find`, { method: 'POST' }),
  found: (cluster: string) => api<OwnFound>(`${base(cluster)}/find`),
};

/** Dashboards of own metrics: the org's, not a cluster's. */
export const ownDashboardsApi = {
  list: () => api<OwnDashboardList>('/own-dashboards'),
  get: (id: string) => api<OwnDashboard>(`/own-dashboards/${id}`),
  create: (name: string, copyOf?: string) =>
    api<{ id: string; name: string }>('/own-dashboards', {
      method: 'POST',
      body: { name, ...(copyOf ? { copyOf } : {}) },
    }),
  save: (id: string, body: { name?: string; widgets?: OwnWidgetInput[] }) =>
    api<OwnDashboard>(`/own-dashboards/${id}`, { method: 'PUT', body }),
  remove: (id: string) => api<void>(`/own-dashboards/${id}`, { method: 'DELETE' }),
};
