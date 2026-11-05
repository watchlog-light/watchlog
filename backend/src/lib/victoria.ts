// SPDX-License-Identifier: AGPL-3.0-only
// VictoriaMetrics client. Every call carries the cluster it is scoped to, and the
// server enforces it with extra_label (measured: it cannot be escaped; ADR-026/028).

export class VictoriaError extends Error {
  constructor(
    message: string,
    /** HTTP status from VictoriaMetrics, or 0 when it was unreachable. */
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ClusterScope {
  clusterId: string;
}

export class VictoriaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
    protected readonly queryTimeoutMs = 15_000,
  ) {}

  protected queryUrl(path: string, scope: ClusterScope, params: Record<string, string>): string {
    return this.url(path, scope, params);
  }

  private url(path: string, scope: ClusterScope, params: Record<string, string> = {}): string {
    const u = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('extra_label', `cluster_id=${scope.clusterId}`);
    return u.toString();
  }

  /** Forwards a remote_write body unchanged; cluster_id is injected by VictoriaMetrics. */
  async write(scope: ClusterScope, body: Uint8Array): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.url('/api/v1/write', scope), {
        method: 'POST',
        headers: {
          'content-type': 'application/x-protobuf',
          'content-encoding': 'snappy',
          'x-prometheus-remote-write-version': '0.1.0',
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new VictoriaError(`VictoriaMetrics unreachable: ${(err as Error).message}`, 0);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new VictoriaError(`VictoriaMetrics write failed: ${res.status} ${text}`, res.status);
    }
    await res.body?.cancel();
  }
}

/** One series of a query result. Values are numbers, or null for NaN/Inf. */
export interface QuerySeries {
  labels: Record<string, string>;
  points: [number, number | null][];
}

interface PromResponse {
  status: string;
  error?: string;
  data?: {
    resultType: 'matrix' | 'vector';
    result: {
      metric: Record<string, string>;
      value?: [number, string];
      values?: [number, string][];
    }[];
  };
}

function toNumber(v: string): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class VictoriaQueryClient extends VictoriaClient {
  private async get(
    path: string,
    scope: ClusterScope,
    params: Record<string, string>,
  ): Promise<PromResponse> {
    let res: Response;
    try {
      res = await fetch(this.queryUrl(path, scope, params), {
        signal: AbortSignal.timeout(this.queryTimeoutMs),
      });
    } catch (err) {
      throw new VictoriaError(`VictoriaMetrics unreachable: ${(err as Error).message}`, 0);
    }
    const body = (await res
      .json()
      .catch(() => ({ status: 'error', error: 'invalid JSON' }))) as PromResponse;
    if (!res.ok || body.status !== 'success') {
      throw new VictoriaError(
        `VictoriaMetrics query failed: ${res.status} ${body.error ?? ''}`.trim(),
        res.status,
      );
    }
    return body;
  }

  /** Instant query; cluster_id is always enforced by VictoriaMetrics. */
  async query(scope: ClusterScope, expr: string, time?: number): Promise<QuerySeries[]> {
    const params: Record<string, string> = { query: expr };
    if (time !== undefined) params.time = String(time);
    const body = await this.get('/api/v1/query', scope, params);
    return (body.data?.result ?? []).map((r) => ({
      labels: r.metric,
      points: r.value ? [[r.value[0], toNumber(r.value[1])]] : [],
    }));
  }

  /** Range query; cluster_id is always enforced by VictoriaMetrics. */
  async queryRange(
    scope: ClusterScope,
    expr: string,
    start: number,
    end: number,
    step: number,
  ): Promise<QuerySeries[]> {
    const body = await this.get('/api/v1/query_range', scope, {
      query: expr,
      start: String(start),
      end: String(end),
      step: `${step}s`,
    });
    return (body.data?.result ?? []).map((r) => ({
      labels: r.metric,
      points: (r.values ?? []).map(([t, v]) => [t, toNumber(v)] as [number, number | null]),
    }));
  }
}
