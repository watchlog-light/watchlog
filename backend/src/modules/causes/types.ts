// SPDX-License-Identifier: AGPL-3.0-only
// Probable cause (ADR-146 to ADR-150): the words the engine, its rules and the route share.
// A cause is a code with facts and an evidence chain; a check is what WatchLog looked at and
// what it found. Sentences are written by the web through i18n (ADR-147), never here.

export type Platform = 'kubernetes' | 'docker';

/** How sure WatchLog is (ADR-147): no numbers, words only. */
export type Strength = 'likely' | 'possible';
export type State = Strength | 'none';

/**
 * Something a chain step or a check is about, with what the UI needs to link to it. `ref`
 * is in the same form as a /causes subject of that kind (subject.ts), so a step's object can
 * be asked about in turn: pod `ns/name`, workload `ns/Kind/name`, container `host/name`,
 * compose_service `project/service`, edge the map's edge id, application its id, alert its
 * id. Kinds that aren't subjects: node and host (their name), change (the change marker's
 * target, e.g. `Deployment/shop/api` or `Container/docker-01/shop-api-1`, with `at` on the
 * step) and cluster (its id).
 */
export type ObjectKind =
  | 'pod'
  | 'workload'
  | 'container'
  | 'compose_service'
  | 'edge'
  | 'application'
  | 'alert'
  | 'node'
  | 'host'
  | 'change'
  | 'cluster';

export interface ObjectRef {
  kind: ObjectKind;
  ref: string;
  /** What to show: `shop/api`, `api-7744d656ff-29575`, `shop-api-1`, `shop/redis`. */
  name: string;
  platform: Platform;
  /** Kubernetes workloads: Deployment, StatefulSet…; a change's object kind. */
  workloadKind?: string;
  /** Docker: the host the container or Compose service runs on. */
  host?: string;
  /** Applications: postgres, redis, rabbitmq… */
  type?: string;
  /** Applications: the product the collector found when it isn't the type's own (mariadb, valkey). */
  product?: string;
}

/** Where a step's fact comes from: the panel's source chip. */
export type Source =
  'service_map' | 'kubernetes' | 'docker' | 'change_marker' | 'metrics' | 'dns' | 'application';

/** The words between two steps of a chain (the mock-up's hop words). */
export type Connector = 'calls' | 'because' | 'consumed_by' | 'looks_up' | 'after';

export type Facts = Record<string, string | number | null>;

export interface Sentence {
  code: string;
  facts: Facts;
}

/** One step of an evidence chain: the symptom first, where it starts last. */
export interface Step extends Sentence {
  object: ObjectRef;
  source: Source;
  /** A moment (a change, a kill); `since` for a state that lasts. */
  at: string | null;
  since: string | null;
  /** How this step leads to the next one; null on the last step. */
  next: Connector | null;
}

/** What a rule found, before ranking gives it a strength. */
export interface Candidate extends Sentence {
  /** The rule's code (ADR-150). */
  rule: string;
  /** When the cause began; null when the evidence doesn't say. */
  since: string | null;
  chain: Step[];
  /** Every link of the chain is backed by evidence (ADR-147: a partial chain is possible). */
  complete: boolean;
  /** Edges followed to reach it: 0 on the subject itself, at most 2 (ADR-146). */
  hops: number;
  /** The panel's first sentence when this cause is the likely one. */
  headline: Sentence;
  /** The checks (by topic) this cause explains. */
  explains: CheckTopic[];
  /**
   * Rules whose cause on the caller (one hop back) this cause explains better: the walk drops
   * their candidates there (dependency_down's stopped container behind the caller's failed
   * lookups covers dns_nxdomain). Not part of the answer.
   */
  coversCaller?: string[];
}

export interface Cause extends Sentence {
  rule: string;
  strength: Strength;
  since: string | null;
  chain: Step[];
}

/** What was looked at; the "what" of a check line. */
export type CheckTopic =
  | 'self'
  | 'events'
  | 'changes'
  | 'node'
  | 'host'
  | 'cpu'
  | 'dependencies'
  | 'dns'
  | 'application'
  | 'edge';

/**
 * What a check came to: it explains the problem (the likely cause came from it), it is a
 * possible cause or something abnormal no rule explains, nothing wrong, couldn't run
 * (no data, network flows off), or doesn't apply here.
 */
export type CheckResult = 'explains' | 'possible' | 'ok' | 'not_run' | 'not_applicable';

export interface Check extends Sentence {
  topic: CheckTopic;
  result: CheckResult;
  /** What it looked at, when it is one object (the node, the host, the edge). */
  object?: ObjectRef;
}

/** A node or host whose agent sees no network flows (the panel's banner). */
export interface FlowsOff {
  node: string;
  /** config, kernel, permission, load or outdated (the service map's words), or null. */
  cause: string | null;
  reason: string | null;
}
