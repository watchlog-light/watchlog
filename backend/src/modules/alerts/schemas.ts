// SPDX-License-Identifier: AGPL-3.0-only
// Schemas of the alerting API (SPEC §8.1; ADR-074…ADR-088).
import { Type, type TSchema } from 'typebox';

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const NullableString = Nullable(Type.String());
export const Id = Type.String({ format: 'uuid' });
export const IdParams = Type.Object({ id: Id });
export const Severity = Type.Union([Type.Literal('warning'), Type.Literal('critical')]);
const Labels = Type.Record(Type.String(), Type.String());

export const AlertingStatusSchema = Type.Object({
  running: Type.Boolean(),
  lastCycleAt: NullableString,
  workers: Type.Integer(),
  /** Messages carry links only with WATCHLOG_PUBLIC_URL (ADR-081). */
  publicUrlConfigured: Type.Boolean(),
  /** Email channels need WATCHLOG_SMTP_URL (ADR-080). */
  smtpConfigured: Type.Boolean(),
});

export const AlertSchema = Type.Object({
  id: Id,
  /** "payments-api is crash-looping" (ADR-095). */
  title: Type.String(),
  /** "last exit: Error (code 1) · 9 restarts"; null when there is nothing to add. */
  why: NullableString,
  state: Type.Union([Type.Literal('pending'), Type.Literal('firing'), Type.Literal('resolved')]),
  severity: Severity,
  rule: Type.Object({ id: Id, key: NullableString, name: Type.String() }),
  cluster: Type.Object({ id: Id, name: Type.String(), kind: Type.String() }),
  labels: Labels,
  summary: NullableString,
  /** Pods of a workload alert (first 5) and how many. */
  pods: Type.Array(Type.String()),
  podCount: Type.Integer(),
  startedAt: Type.String(),
  firedAt: NullableString,
  resolvedAt: NullableString,
  silenced: Type.Boolean(),
  flapping: Type.Boolean(),
  /** Held back while its cluster is not reporting or its node is NotReady (ADR-094). */
  held: Type.Boolean(),
  /** The latest firing message per channel (alerts redesign item 7). */
  deliveries: Type.Array(
    Type.Object({
      channelId: Id,
      name: Type.String(),
      type: Type.String(),
      status: Type.String(),
      error: NullableString,
    }),
  ),
});

export const AlertListSchema = Type.Object({
  alerts: Type.Array(AlertSchema),
  nextCursor: NullableString,
  counts: Type.Object({
    firing: Type.Integer(),
    critical: Type.Integer(),
    warning: Type.Integer(),
    pending: Type.Integer(),
    silenced: Type.Integer(),
    held: Type.Integer(),
  }),
});

export const NotificationSchema = Type.Object({
  id: Id,
  kind: Type.String(),
  status: Type.String(),
  error: NullableString,
  attempts: Type.Integer(),
  createdAt: Type.String(),
  sentAt: NullableString,
  channel: Nullable(Type.Object({ id: Id, name: Type.String(), type: Type.String() })),
});

export const AlertDetailSchema = Type.Object({
  alert: AlertSchema,
  notifications: Type.Array(NotificationSchema),
  /** Earlier episodes of the same rule and scope, newest first (at most 10). */
  history: Type.Array(AlertSchema),
  /** Times alerting was not running while this alert was open (to: null = still not). */
  gaps: Type.Array(Type.Object({ from: Type.String(), to: NullableString })),
});

export const SilenceMatchersSchema = Type.Object(
  {
    rule: Type.Optional(Id),
    cluster: Type.Optional(Id),
    namespace: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
    workload: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
    node: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
    severity: Type.Optional(Severity),
  },
  { additionalProperties: false },
);

export const SilenceSchema = Type.Object({
  id: Id,
  matchers: SilenceMatchersSchema,
  startsAt: Type.String(),
  endsAt: Type.String(),
  comment: Type.String(),
  createdBy: NullableString,
  active: Type.Boolean(),
  /** Alerts it silences right now. */
  matching: Type.Integer(),
});

export const CreateSilenceSchema = Type.Object({
  matchers: SilenceMatchersSchema,
  /** Minutes from now; at most 30 days. */
  durationMinutes: Type.Integer({ minimum: 1, maximum: 43200 }),
  comment: Type.String({ maxLength: 1000, default: '' }),
});

export const ConditionSchema = Type.Object(
  {
    op: Type.Union([Type.Literal('>'), Type.Literal('<')]),
    value: Type.Number(),
    critical: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

const Span = Type.Object({ from: Type.Integer(), to: Type.Integer() });
const Tone = Type.Union([
  Type.Literal('ok'),
  Type.Literal('warning'),
  Type.Literal('critical'),
  Type.Literal('neutral'),
]);

/** One panel of an alert's chart: lines (with thresholds) or state timelines. */
export const ChartPanelSchema = Type.Object({
  id: Type.Union([
    Type.Literal('metric'),
    Type.Literal('restarts'),
    Type.Literal('cpu'),
    Type.Literal('memory'),
    Type.Literal('conditions'),
    Type.Literal('phases'),
    Type.Literal('replicas'),
    Type.Literal('health'),
    Type.Literal('samples'),
  ]),
  kind: Type.Union([Type.Literal('line'), Type.Literal('bands')]),
  metric: NullableString,
  unit: NullableString,
  lines: Type.Array(
    Type.Object({
      name: Type.String(),
      points: Type.Array(Type.Array(Type.Union([Type.Number(), Type.Null()]))),
      step: Type.Optional(Type.Boolean()),
    }),
  ),
  thresholds: Type.Array(
    Type.Object({
      kind: Type.Union([Type.Literal('warning'), Type.Literal('critical'), Type.Literal('limit')]),
      value: Type.Number(),
    }),
  ),
  rows: Type.Array(
    Type.Object({
      name: Type.String(),
      segments: Type.Array(
        Type.Object({ from: Type.Integer(), to: Type.Integer(), state: Type.String(), tone: Tone }),
      ),
    }),
  ),
  /** Objects beyond the 10 shown. */
  more: Type.Integer(),
});

/** An alert's chart (times in unix seconds). */
export const AlertChartSchema = Type.Object({
  window: Span,
  panels: Type.Array(ChartPanelSchema),
  markers: Type.Array(
    Type.Object({
      ts: Type.Integer(),
      kind: Type.Union([
        Type.Literal('started'),
        Type.Literal('fired'),
        Type.Literal('resolved'),
        Type.Literal('silenced'),
        Type.Literal('notification'),
        Type.Literal('oom'),
        Type.Literal('lastData'),
      ]),
      channel: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      messageKind: Type.Optional(Type.String()),
    }),
  ),
  firing: Nullable(Span),
  episodes: Type.Array(Span),
  gaps: Type.Array(Span),
  silent: Nullable(Span),
  ruleChanged: Nullable(
    Type.Object({
      condition: Nullable(ConditionSchema),
      forSeconds: Type.Integer(),
      unit: NullableString,
    }),
  ),
});

export const ChartQuerySchema = Type.Object({
  /** Seconds from the time-range picker; only ever widens the alert's window. */
  range: Type.Optional(Type.Integer({ minimum: 60, maximum: 30 * 86400 })),
});

export const ThresholdScopeSchema = Type.Object(
  {
    namespaces: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 63 }), { maxItems: 50 }),
    ),
    workload: Type.Optional(
      Type.Object({
        namespace: Type.String({ minLength: 1, maxLength: 63 }),
        kind: Type.String({ minLength: 1, maxLength: 63 }),
        name: Type.String({ minLength: 1, maxLength: 253 }),
      }),
    ),
    node: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
    host: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
    container: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
    /** A monitored service (SPEC §4.12): its id on the Applications page. */
    service: Type.Optional(Type.String({ format: 'uuid' })),
    /** Pod label selector (equality); resolved to at most 500 pods (ADR-085). */
    labels: Type.Optional(
      Type.Record(Type.String({ maxLength: 317 }), Type.String({ maxLength: 63 }), {
        maxProperties: 10,
      }),
    ),
  },
  { additionalProperties: false },
);

export const RuleSchema = Type.Object({
  id: Id,
  type: Type.Union([Type.Literal('default'), Type.Literal('threshold')]),
  ruleKey: NullableString,
  name: Type.String(),
  /** state: from objects and heartbeats; metric: a threshold on a catalog metric. */
  source: Type.Union([Type.Literal('state'), Type.Literal('metric')]),
  /** Unit of the condition's thresholds (metric rules). */
  unit: NullableString,
  metric: NullableString,
  clusterId: NullableString,
  /** Cluster kinds the rule applies to. */
  appliesTo: Type.Array(Type.String()),
  scope: ThresholdScopeSchema,
  condition: Nullable(ConditionSchema),
  forSeconds: Type.Integer(),
  renotifySeconds: Type.Integer(),
  severity: Severity,
  enabled: Type.Boolean(),
  channelIds: Type.Array(Id),
  firing: Type.Integer(),
  evalError: NullableString,
  defaultKey: NullableString,
  /** The monitored service a rule is scoped to; null when it was removed. */
  service: Type.Optional(
    Type.Union([
      Type.Object({ id: Type.String(), name: Type.String(), type: Type.String() }),
      Type.Null(),
    ]),
  ),
});

export const PatchRuleSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    enabled: Type.Optional(Type.Boolean()),
    forSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 86400 })),
    renotifySeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 604800 })),
    severity: Type.Optional(Severity),
    condition: Type.Optional(ConditionSchema),
    channelIds: Type.Optional(Type.Array(Id, { maxItems: 50 })),
    clusterId: Type.Optional(Nullable(Id)),
    scope: Type.Optional(ThresholdScopeSchema),
  },
  { additionalProperties: false },
);

export const CreateRuleSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    metric: Type.String({ minLength: 1, maxLength: 100 }),
    clusterId: Nullable(Id),
    scope: ThresholdScopeSchema,
    condition: ConditionSchema,
    forSeconds: Type.Integer({ minimum: 0, maximum: 86400 }),
    renotifySeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 604800 })),
    severity: Severity,
    channelIds: Type.Array(Id, { maxItems: 50 }),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ChannelType = Type.Union([
  Type.Literal('slack'),
  Type.Literal('telegram'),
  Type.Literal('email'),
  Type.Literal('webhook'),
]);

const Url = Type.String({ minLength: 8, maxLength: 2048, pattern: '^https?://' });
const Email = Type.String({ minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+$' });

/** Settings per type; secrets are write-only (ADR-079). */
export const ChannelSettingsSchema = Type.Object(
  {
    webhookUrl: Type.Optional(Url),
    botToken: Type.Optional(
      Type.String({ minLength: 20, maxLength: 200, pattern: '^[0-9]+:[A-Za-z0-9_-]+$' }),
    ),
    recipients: Type.Optional(Type.Array(Email, { minItems: 1, maxItems: 20 })),
    url: Type.Optional(Url),
    signingSecret: Type.Optional(Type.String({ minLength: 16, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const CreateChannelSchema = Type.Object(
  {
    type: ChannelType,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    settings: ChannelSettingsSchema,
    /** Add the channel to every rule; default true for the org's first channel (ADR-084). */
    useForAllRules: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PatchChannelSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    settings: Type.Optional(ChannelSettingsSchema),
  },
  { additionalProperties: false },
);

export const ChannelSchema = Type.Object({
  id: Id,
  type: ChannelType,
  name: Type.String(),
  /** Visible settings: recipients, webhook URL, bot and chat names. */
  config: Type.Object({
    recipients: Type.Optional(Type.Array(Type.String())),
    url: Type.Optional(Type.String()),
    botName: Type.Optional(Type.String()),
    chatName: Type.Optional(Type.String()),
    connected: Type.Optional(Type.Boolean()),
  }),
  /** Secret fields that are set, shown as their last 4 characters. */
  secrets: Type.Record(Type.String(), Type.String()),
  verifiedAt: NullableString,
  lastSentAt: NullableString,
  lastError: NullableString,
  lastErrorAt: NullableString,
  createdAt: Type.String(),
  ruleCount: Type.Integer(),
});

export const CreatedChannelSchema = Type.Object({
  channel: ChannelSchema,
  /** A generated webhook signing secret, shown once. */
  signingSecret: Type.Optional(Type.String()),
  /** Telegram: the link that connects a chat (10 minutes). */
  connect: Type.Optional(Type.Object({ link: Type.String(), expiresAt: Type.String() })),
});

export const TestResultSchema = Type.Object({ ok: Type.Boolean(), error: NullableString });

export const PreviewBodySchema = Type.Object(
  {
    /** The rule being edited; the other fields override its settings. */
    ruleId: Type.Optional(Id),
    metric: Type.Optional(Type.String({ maxLength: 100 })),
    clusterId: Type.Optional(Nullable(Id)),
    scope: Type.Optional(ThresholdScopeSchema),
    condition: Type.Optional(ConditionSchema),
    forSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 86400 })),
  },
  { additionalProperties: false },
);

export const PreviewSchema = Type.Object({
  /** metric: a 24 h backtest; state: how often it fired in the last 7 days. */
  kind: Type.Union([Type.Literal('metric'), Type.Literal('state')]),
  fired: Type.Integer(),
  critical: Type.Integer(),
  hours: Type.Integer(),
  unit: NullableString,
  /** State rules: the chart of the latest alert in those 7 days, as on its page. */
  chart: Type.Optional(Nullable(AlertChartSchema)),
  /** The busiest series of the backtest, for the chart. */
  series: Nullable(
    Type.Object({
      name: Type.String(),
      points: Type.Array(Type.Array(Type.Union([Type.Number(), Type.Null()]))),
    }),
  ),
});
