-- Up Migration
-- "Reset to default" for a monitored service's default rules (v0.3 slice 7): each one
-- remembers which default it came from. Nullable and additive (ADR-107); the two defaults
-- of slice 5 are filled in from their metric and name.
ALTER TABLE alert_rules ADD COLUMN default_key text CHECK (length(default_key) <= 64);

UPDATE alert_rules SET default_key = 'unreachable'
  WHERE type = 'threshold' AND scope ? 'service' AND metric = 'service.reachable.ratio'
    AND name = 'Service unreachable';
UPDATE alert_rules SET default_key = 'slow_connect'
  WHERE type = 'threshold' AND scope ? 'service' AND metric = 'service.connect.time'
    AND name = 'Service slow to connect';
