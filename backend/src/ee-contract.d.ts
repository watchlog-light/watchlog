// SPDX-License-Identifier: AGPL-3.0-only
// What the core gives an Enterprise module (ee/backend, ADR-232), and what a module gives
// back. Types only: ee/backend imports this file with `import type`, so it compiles on its
// own and the core never imports ee/'s code; at run time the core finds ee/backend's entry
// (ee.ts) and calls each module's `register`. The core builds and runs with ee/ deleted.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// The schema options the core's routes use (`hide`, `tags`), for ee's routes too.
import '@fastify/swagger';
import type { Kysely, sql as Sql } from 'kysely';

// Only types from packages here: a module compiles with ee/backend/src as its root, so this
// file names no other file of the core. The shapes below match the core's (lib/victoria.ts
// QuerySeries, alerts/state-machine.ts Observation, events/record.ts RecordedEvent); the
// core's typecheck holds ee.ts to them.
export type { FastifyInstance, FastifyReply, FastifyRequest };

/** The database, untyped for a module (its tables are its own; the core's are read by name). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EeDb = Kysely<any>;

export interface QuerySeries {
  labels: Record<string, string>;
  points: [number, number | null][];
}

export interface Observation {
  fingerprint: string;
  severity: 'warning' | 'critical';
  labels: Record<string, string>;
  details: Record<string, unknown>;
  since?: number;
  changedAt?: number;
}

export interface RecordedEvent {
  orgId: string;
  clusterId: string;
  kind: string;
  name: string;
  key: string;
  host: string;
  reason: string;
  type: 'Normal' | 'Warning';
  message: string;
  at: number;
  source: string;
}

/** A count of units an Enterprise licence includes, from a module (network devices). */
export interface EeUnitSource {
  name: string;
  /** Each org's count now (the hourly usage job stores it in usage_hourly.devices). */
  current(db: unknown): Promise<Map<string, number>>;
}

type PreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply | undefined>;

export interface EeHost {
  edition: 'community' | 'cloud';
  demoMode: boolean;
  /** The core's sign-in check (a session or an API token), as every route uses it. */
  requireUser(): PreHandler;
  /** The core's role guard (ADR-140): the route walk sees the roles it declares. */
  requireRole(...roles: ('owner' | 'admin' | 'viewer')[]): PreHandler;
  /**
   * A preHandler for the module's routes: 404 when the feature isn't licensed here (as if the
   * route didn't exist), 403 `license-ended` when its licence ended, else on. Read per request,
   * so a key pasted in Settings works at once.
   */
  requireFeature(feature: string): PreHandler;
  /** Whether an org has a feature now (Cloud: its Pro plan; self-hosted: the licence). */
  hasFeature(orgId: string, feature: string): Promise<boolean>;
  /** Adds the module's devices to the licence's unit count (license/units.ts). */
  registerUnitSource(source: EeUnitSource): void;
  log: {
    info(o: object, m: string): void;
    warn(o: object, m: string): void;
    error(o: object, m: string): void;
  };

  /**
   * The request path's database (Cloud: Row-Level Security by the request's org) and the
   * system one (ingest and loops across orgs; the module scopes every query by org itself).
   */
  db: EeDb;
  systemDb: EeDb;
  sql: typeof Sql;
  newId(): string;
  /** AES-256-GCM with the install's secret key, bound to a row by `aad` (ADR-133). */
  secrets: {
    encrypt(plain: string, aad: string): string;
    decrypt(cipher: string, aad: string): string;
  };
  /**
   * Queries VictoriaMetrics over clusters of one org (the core checks they are the org's);
   * null without VICTORIAMETRICS_URL.
   */
  victoria: {
    query(orgId: string, clusterIds: string[], expr: string, time?: number): Promise<QuerySeries[]>;
    queryRange(
      orgId: string,
      clusterIds: string[],
      expr: string,
      start: number,
      end: number,
      step: number,
    ): Promise<QuerySeries[]>;
  } | null;
  /** The integrations collector's configuration (ADR-131). */
  collector: {
    /**
     * A section of each collector's configuration, `modules.<name>` (agent/ext): built per
     * collector, left out when `build` gives undefined (the org hasn't the feature).
     */
    registerSection(
      name: string,
      build: (c: { orgId: string; clusterId: string; host: string }) => Promise<unknown>,
    ): void;
    /** Wakes the cluster's collectors waiting on their configuration. */
    notify(clusterId: string): void;
  };
  /** Events in a place's Events list (k8s_events), de-duplicated per day like the agents'. */
  events: { record(e: RecordedEvent): Promise<void> };
  /** Default alert rules from a module (alerts/rules.ts), and adding them to an org. */
  alerts: {
    register(rules: EeAlertRule[]): void;
    ensure(orgId: string): Promise<void>;
  };
  now(): number;
  /**
   * Self-hosted with a licence 30 days in a row over its units (ADR-232): from when licensed
   * features take on nothing new (no new network devices). Null otherwise, and in Cloud.
   */
  closedSince(): Promise<number | null>;
}

/** A default alert rule from a module: evaluated per cluster like the core's. */
export interface EeAlertRule {
  key: string;
  name: string;
  severity: 'warning' | 'critical';
  forSeconds: number;
  condition?: { op: '>' | '<'; value: number; critical?: number };
  unit?: 'ratio' | 'count' | 'bytes' | 'seconds';
  /** Held back under this rule's alert on the same device (`device_id`), ADR-229. */
  heldUnder?: string;
  evaluator: {
    kinds: readonly ('kubernetes' | 'server')[];
    evaluate(ctx: {
      db: EeDb;
      rule: { id: string; condition: unknown; for_seconds: number; org_id: string };
      cluster: { id: string; name: string; kind: 'kubernetes' | 'server' };
      now: number;
      memo<T>(key: string, load: () => Promise<T>): Promise<T>;
    }): Promise<Observation[]>;
  };
}

export interface EeBackendModule {
  /** A short name, for logs: "network". */
  name: string;
  /** The licence feature that turns the module on: "network". */
  feature: string;
  /** Registers the module's routes under /api/v1, each behind host.requireFeature. */
  register(api: FastifyInstance, host: EeHost): Promise<void>;
  /**
   * Registers routes under /ingest/v1 with the agents' token auth: `request.ingestOwner`
   * (`{ clusterId, orgId }`) says whose collector posts.
   */
  registerIngest?(ingest: FastifyInstance, host: EeHost): void;
  /**
   * In the alert-worker process: what the module's alert rules and unit count need there
   * (host.alerts.register, host.registerUnitSource). Its routes aren't registered there.
   */
  worker?(host: EeHost): Promise<void>;
  /**
   * The seed file's `modules.<name>` (ADR-142's seed, for the demo): applied to the first org
   * at start and every minute (its clusters and collectors may come later); it must be
   * idempotent and answer what is still missing.
   */
  seed?(host: EeHost, orgId: string, section: unknown): Promise<{ pending: boolean }>;
}
