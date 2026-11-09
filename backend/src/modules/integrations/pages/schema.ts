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

const base = {
  id: Type.String(),
  title: Type.String({ description: 'An i18n key' }),
  span: Type.Union([Type.Literal(1), Type.Literal(2)]),
  state: State,
  missing: Type.Optional(Text),
  note: Type.Optional(Text),
};

export const PanelSchema = Type.Union([
  Type.Object({
    ...base,
    kind: Type.Union([Type.Literal('line'), Type.Literal('stack')]),
    unit: Unit,
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
    rows: Type.Array(
      Type.Object({
        cells: Type.Array(Type.Union([Type.String(), Type.Number(), Type.Null()])),
        severity: Type.Optional(Severity),
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
]);

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

export const TabSchema = Type.Object({ id: Type.String(), title: Type.String() });
