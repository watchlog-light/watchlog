-- Up Migration
-- The likely cause an alert had when it fired (ADR-157): worked out once, just before its
-- firing message is sent, within 2 s. `cause` holds {state, ms, likely?}; `cause_at` says it
-- was worked out (null: not yet, or the alert fired before this column). The resolve message
-- says "Was likely: …" from it. Additive (ADR-107).
ALTER TABLE alert_states ADD COLUMN cause jsonb;
ALTER TABLE alert_states ADD COLUMN cause_at timestamptz;
