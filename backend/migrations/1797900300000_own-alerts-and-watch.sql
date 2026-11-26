-- Up Migration
-- Alerts on a user's own metrics (1.0.0, ADR-236): ordinary rows of alert_rules with their own
-- type, so they are evaluated, grouped, silenced and sent like every other rule. What the rule
-- is about is in `scope.own` ({metric, is, per}); `condition` keeps the value compared with.
ALTER TABLE alert_rules DROP CONSTRAINT alert_rules_type_check;
ALTER TABLE alert_rules
  ADD CONSTRAINT alert_rules_type_check CHECK (type IN ('default', 'threshold', 'own'));

-- "Watch with What changed" (Pro, ADR-238): the metric's usual range is learnt and shown, and
-- "outside its usual range" can be alerted on. At most 50 watched metrics per org.
ALTER TABLE own_metrics ADD COLUMN watched_at timestamptz;
CREATE INDEX own_metrics_watched_idx ON own_metrics (org_id) WHERE watched_at IS NOT NULL;

-- Down Migration
DROP INDEX own_metrics_watched_idx;
ALTER TABLE own_metrics DROP COLUMN watched_at;
DELETE FROM alert_rules WHERE type = 'own';
ALTER TABLE alert_rules DROP CONSTRAINT alert_rules_type_check;
ALTER TABLE alert_rules
  ADD CONSTRAINT alert_rules_type_check CHECK (type IN ('default', 'threshold'));
