// SPDX-License-Identifier: AGPL-3.0-only
// The service page's response schemas (ADR-135): panels by kind, reasons, key metrics,
// connected workloads. The interfaces in types.ts are what the page code builds; these
// describe the same shapes on the wire.
import { Type } from 'typebox';

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) =>
  Type.Union([t, Type.Null()]);
const Fact = Type.Union([Type.String(), Type.Number(), Type.Null()]);
const Facts = Type.Record(Type.String(), Fact);
const Severity = Type.Union([
  Type.Literal('ok'),
  Type.Literal('info'),
  Type.Literal('warning'),
  Type.Literal('critical'),
]);
const Unit = Type.Union(
  [
    Type.Literal('ratio'),
    Type.Literal('bytes'),
    Type.Literal('bytes_per_second'),
    Type.Literal('cores'),
    Type.Literal('load'),
    Type.Literal('count'),
    Type.Literal('seconds'),
    Type.Literal('per_second'),
  ],
  { description: "The dashboard's unit names" },
);
const Text = Type.Object({ key: Type.String(), values: Type.Optional(Facts) });
// [unix seconds, value or null]; a plain array: the serializer doesn't take tuples.
const Point = Type.Array(Type.Union([Type.Number(), Type.Null()]), { minItems: 2, maxItems: 2 });
const State = Type.Union([
  Type.Literal('ok'),
  Type.Literal('empty'),
  Type.Literal('needs_permission'),
  Type.Literal('error'),
]);

const Link = Type.Union([
  Type.Object({
    kind: Type.Union([Type.Literal('workload'), Type.Literal('container')]),
    id: Type.String(),
    name: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('queue'),
    vhost: Type.String(),
    queue: Type.String(),
    name: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('tab'),
    tab: Type.String(),
    filter: Type.Optional(Type.String()),
    name: Type.String(),
  }),
  Type.Object({ kind: Type.Literal('docs'), href: Type.String(), name: Type.String() }),
  Type.Object({
    kind: Type.Union([Type.Literal('statement'), Type.Literal('table')]),
    id: Type.String(),
    name: Type.String(),
  }),
  // 1.4: another item page (Redis's prefix, command, stream group).
  Type.Object({
    kind: Type.Literal('item'),
    tab: Type.String(),
    id: Type.String(),
    name: Type.String(),
  }),
]);
const Num = Nullable(Type.Number());

const base = {
  id: Type.String(),
  title: Type.String({ description: 'An i18n key' }),
  span: Type.Union([Type.Literal(1), Type.Literal(2)]),
  state: State,
  missing: Type.Optional(Text),
  note: Type.Optional(Text),
  layout: Type.Optional(Type.Union([Type.Literal('side'), Type.Literal('main')])),
};

export const PanelSchema = Type.Union([
  Type.Object({
    ...base,
    kind: Type.Union([Type.Literal('line'), Type.Literal('stack')]),
    unit: Unit,
    markers: Type.Optional(
      Type.Array(Type.Object({ at: Type.Number(), text: Text, severity: Type.Optional(Severity) })),
    ),
    band: Type.Optional(
      Type.Object(
        { low: Type.Array(Point), high: Type.Array(Point) },
        {
          description: 'The usual range of the first series, for this hour of the week',
        },
      ),
    ),
    zeroKey: Type.Optional(
      Type.String({ description: 'A line said instead of the chart when every point is zero' }),
    ),
    select: Type.Optional(
      Type.Boolean({ description: 'A period can be chosen on it; the lists below follow it' }),
    ),
    series: Type.Array(
      Type.Object({
        name: Type.Optional(Type.String()),
        nameKey: Type.Optional(Type.String()),
        points: Type.Array(Point),
        dashed: Type.Optional(Type.Boolean()),
        severity: Type.Optional(Severity),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('bars'),
    unit: Unit,
    items: Type.Array(
      Type.Object({
        label: Type.String(),
        value: Type.Number(),
        severity: Type.Optional(Severity),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('hist'),
    buckets: Type.Array(Type.Object({ label: Type.String(), share: Type.Number() })),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('gauge'),
    items: Type.Array(
      Type.Object({
        label: Type.Optional(Type.String()),
        labelKey: Type.Optional(Type.String()),
        value: Type.Number(),
        max: Type.Number(),
        unit: Unit,
        warnAt: Type.Optional(Type.Number()),
        note: Type.Optional(Text),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('heat'),
    unit: Unit,
    points: Type.Array(Point),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('table'),
    columns: Type.Array(Type.String()),
    clock: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
    rows: Type.Array(
      Type.Object({
        cells: Type.Array(Type.Union([Type.String(), Type.Number(), Type.Null()])),
        severity: Type.Optional(Severity),
        link: Type.Optional(Link),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('stat'),
    tiles: Type.Array(
      Type.Object({
        id: Type.String(),
        labelKey: Type.String(),
        value: Type.Union([Type.String(), Type.Number(), Type.Null()]),
        unit: Type.Optional(Unit),
        sub: Type.Optional(Text),
        severity: Type.Optional(Severity),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('flow'),
    columns: Type.Array(
      Type.Object({
        id: Type.String(),
        title: Text,
        value: Num,
        unit: Unit,
        valueKey: Type.Optional(Type.String()),
        severity: Type.Optional(Severity),
        rows: Type.Array(
          Type.Object({
            name: Type.String(),
            nameKey: Type.Optional(Type.String()),
            value: Num,
            unit: Unit,
            text: Type.Optional(Text),
            severity: Type.Optional(Severity),
            link: Type.Optional(Link),
          }),
        ),
        next: Type.Optional(Num),
        nextText: Type.Optional(Text),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('checks'),
    items: Type.Array(
      Type.Object({
        id: Type.String(),
        labelKey: Type.String(),
        state: Type.Union([Type.Literal('pass'), Type.Literal('warn'), Type.Literal('fail')]),
        value: Text,
        link: Type.Optional(Link),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('queues'),
    full: Type.Boolean(),
    total: Type.Integer(),
    rows: Type.Array(QueueRowSchema()),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('clients'),
    rows: Type.Array(
      Type.Object({
        name: Type.String(),
        link: Type.Optional(Link),
        where: Text,
        connections: Type.Number(),
        sends: Num,
        receives: Num,
        mostly: Nullable(Type.Union([Type.Literal('publishes'), Type.Literal('consumes')])),
        state: Text,
        severity: Type.Optional(Severity),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('nodes'),
    items: Type.Array(
      Type.Object({
        name: Type.String(),
        version: Nullable(Type.String()),
        uptime: Num,
        connections: Num,
        leaders: Num,
        down: Type.Optional(Type.String()),
        severity: Type.Optional(Severity),
        limits: Type.Array(
          Type.Object({
            labelKey: Type.String(),
            value: Type.Number(),
            max: Type.Number(),
            unit: Unit,
            inverse: Type.Optional(Type.Boolean()),
          }),
        ),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('timeline'),
    events: Type.Array(
      Type.Object({
        at: Type.Number(),
        text: Text,
        sourceKey: Type.String(),
        severity: Type.Optional(Severity),
        link: Type.Optional(Link),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('facts'),
    rows: Type.Array(
      Type.Object({
        labelKey: Type.String(),
        value: Type.Union([Type.String(), Type.Number(), Type.Null()]),
        unit: Type.Optional(Unit),
        text: Type.Optional(Text),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('cause'),
    text: Nullable(Text),
    caveat: Text,
    links: Type.Array(Link),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('queue_alerts'),
    vhost: Type.String(),
    queue: Type.String(),
    rules: Type.Array(
      Type.Object({
        id: Type.String(),
        name: Type.String(),
        state: Type.Union([Type.Literal('firing'), Type.Literal('quiet'), Type.Literal('off')]),
      }),
    ),
    presets: Type.Array(
      Type.Object({
        key: Type.String(),
        nameKey: Type.String(),
        metric: Type.String(),
        op: Type.Union([Type.Literal('>'), Type.Literal('<')]),
        value: Type.Number(),
        forSeconds: Type.Integer(),
        severity: Type.Union([Type.Literal('warning'), Type.Literal('critical')]),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('statements'),
    rows: Type.Array(
      Type.Object({
        id: Type.String(),
        text: Type.String(),
        calls: Num,
        mean: Num,
        usual: Num,
        rows: Num,
        share: Num,
        sentBy: Nullable(
          Type.Object({ name: Type.String(), share: Type.Number(), link: Type.Optional(Link) }),
        ),
        hint: Type.Optional(Text),
        severity: Type.Optional(Severity),
      }),
    ),
    shareOf: Type.Union([Type.Literal('time'), Type.Literal('waits')]),
    full: Type.Boolean(),
    total: Type.Integer(),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('tree'),
    nodes: Type.Array(
      Type.Object({
        id: Type.String(),
        depth: Type.Integer(),
        name: Type.String(),
        link: Type.Optional(Link),
        state: Text,
        seconds: Type.Number(),
        xact: Num,
        query: Nullable(Type.String()),
        severity: Type.Optional(Severity),
      }),
    ),
  }),
  Type.Object({
    ...base,
    kind: Type.Literal('scoped_alerts'),
    scope: Type.Object({
      statement: Type.Optional(Type.String()),
      table: Type.Optional(Type.String()),
    }),
    rules: Type.Array(
      Type.Object({
        id: Type.String(),
        name: Type.String(),
        state: Type.Union([Type.Literal('firing'), Type.Literal('quiet'), Type.Literal('off')]),
      }),
    ),
    presets: Type.Array(
      Type.Object({
        key: Type.String(),
        nameKey: Type.String(),
        metric: Type.String(),
        op: Type.Union([Type.Literal('>'), Type.Literal('<')]),
        value: Type.Number(),
        forSeconds: Type.Integer(),
        severity: Type.Union([Type.Literal('warning'), Type.Literal('critical')]),
      }),
    ),
  }),
]);

/** One RabbitMQ queue's row (the Queues tab, the API and MCP). */
export function QueueRowSchema() {
  return Type.Object({
    vhost: Type.String(),
    queue: Type.String(),
    name: Type.String(),
    type: Nullable(
      Type.Union([Type.Literal('classic'), Type.Literal('quorum'), Type.Literal('stream')]),
    ),
    ready: Type.Number(),
    unacked: Type.Number(),
    in: Num,
    out: Num,
    consumers: Num,
    busy: Num,
    drain: Type.Union([
      Type.Object({ state: Type.Literal('eta'), seconds: Type.Number() }),
      Type.Object({
        state: Type.Union([
          Type.Literal('growing'),
          Type.Literal('never'),
          Type.Literal('empty'),
          Type.Literal('stream'),
        ]),
      }),
    ]),
    severity: Type.Optional(Severity),
  });
}

export const ReasonSchema = Type.Object({
  severity: Severity,
  code: Type.String(),
  facts: Facts,
  links: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.Union([
          Type.Literal('workload'),
          Type.Literal('container'),
          Type.Literal('alert'),
        ]),
        id: Type.String(),
        name: Type.String(),
      }),
    ),
  ),
});

export const KeyMetricSchema = Type.Object({
  id: Type.String(),
  labelKey: Type.String(),
  value: Nullable(Type.Number()),
  unit: Unit,
  severity: Type.Optional(Severity),
});

export const RowMetricsSchema = Type.Object({
  keyMetrics: Type.Array(KeyMetricSchema),
  spark: Type.Array(Point),
});

export const ConnectedSchema = Type.Object({
  flows: Type.Boolean({ description: 'Whether the agents report network flows at all' }),
  items: Type.Array(
    Type.Object({
      kind: Type.Union([Type.Literal('workload'), Type.Literal('container')]),
      name: Type.String(),
      namespace: Nullable(Type.String()),
      workloadKind: Nullable(Type.String()),
      composeService: Nullable(Type.String()),
      connections: Type.Integer(),
      failed: Type.Integer(),
    }),
  ),
});

export const TabSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  view: Type.Optional(Type.Literal('alerts')),
  count: Type.Optional(Nullable(Type.Integer())),
});
