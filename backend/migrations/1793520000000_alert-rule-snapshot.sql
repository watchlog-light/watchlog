-- Up Migration
-- The rule as an alert was evaluated (alert detail page): name, condition, duration,
-- severity and the metric, so its chart draws the thresholds it had at the time and
-- can say "Rule changed since". Null for alerts written before this column.

ALTER TABLE alert_states ADD COLUMN rule_snapshot jsonb;
