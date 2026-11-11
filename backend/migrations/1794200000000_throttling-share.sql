-- Up Migration
-- The "Container CPU throttling" default rule reads the share of the time a container is
-- throttled (throttled seconds a second, at most 1) instead of throttled ÷ used (ADR-160).
-- A threshold kept for the old quantity can't be translated into the new one, so a stored
-- threshold other than the shipped 25 % goes back to it; the rule's switch, channels,
-- severity, duration and history stay (ADR-107: no manual step).
UPDATE alert_rules SET condition = '{"op": ">", "value": 0.25}'::jsonb
  WHERE rule_key = 'k8s.container.throttling'
    AND condition IS DISTINCT FROM '{"op": ">", "value": 0.25}'::jsonb;
