-- Up Migration
-- What changed is ready after 7 days of data, not 7 days on the calendar (0.9.6, ADR-217):
-- the worker now records, per hour of the week, when it last recomputed it and how often, so
-- an hour when the org was not on Pro, the worker was down or the agents sent nothing is
-- seen as not learned, by the worker's scoring and by the page alike.
--   looked_at: per hour of the week (as `hours`), the start of the hour last recomputed;
--   looks:     how many different hours were recomputed for it, up to 2 (two looks with no
--              data settle a silent hour);
--   ready_at:  when the worker found every hour of the week settled;
--   resumed_at: the hour learning went on after a gap.
-- Rows written by 0.9.4 and 0.9.5 have no looks: the worker and the page derive them from
-- `hours` until the next hourly recompute stores them.
ALTER TABLE anomaly_learning
  ADD COLUMN looked_at timestamptz[] NOT NULL
    DEFAULT array_fill(NULL::timestamptz, ARRAY[168]) CHECK (cardinality(looked_at) = 168),
  ADD COLUMN looks smallint[] NOT NULL
    DEFAULT array_fill(0::smallint, ARRAY[168]) CHECK (cardinality(looks) = 168),
  ADD COLUMN ready_at timestamptz,
  ADD COLUMN resumed_at timestamptz;
