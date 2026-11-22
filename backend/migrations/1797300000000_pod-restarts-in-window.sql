-- Up Migration
-- A custom rule on a pod's restarts reads the restarts within the last 15 minutes (0.12.1,
-- ADR-229), not the count since the pod started: that count only grows, so "restarts above 3"
-- fired once and never resolved, even for a pod that had stopped restarting days before.
-- Existing rules move to the windowed metric with their threshold: "above 3" now means more
-- than 3 restarts in 15 minutes, which is what a restart rule is for. Their open alerts
-- resolve at the next check when the pod is no longer restarting, with the usual message.
UPDATE alert_rules
SET metric = 'pod.restarts.increase', updated_at = now()
WHERE metric = 'pod.restarts';
