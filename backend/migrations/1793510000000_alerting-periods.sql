-- Up Migration
-- When alerting ran (alert detail page): each evaluated worker cycle extends the latest
-- period, or starts a new one after more than 2 minutes without a cycle (ADR-088's
-- threshold). The gaps between periods are shown in an alert's timeline ("Alerting was
-- not running 21:45–02:19"). Heartbeat rows are deleted when a worker stops and pruned
-- after a day, so they cannot serve as this history.

CREATE TABLE alerting_periods (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  CHECK (ended_at >= started_at)
);
CREATE INDEX alerting_periods_ended_idx ON alerting_periods (ended_at);

-- What the heartbeats still know: each worker ran from its start to its last cycle.
INSERT INTO alerting_periods (id, started_at, ended_at)
SELECT gen_random_uuid(), started_at, last_cycle_at
  FROM alert_worker_heartbeats
 WHERE last_cycle_at IS NOT NULL AND last_cycle_at >= started_at;
