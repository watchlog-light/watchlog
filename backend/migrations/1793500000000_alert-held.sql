-- Up Migration
-- Alerts redesign item 5 (ADR-094): an alert is held — kept as it is, neither notified
-- nor resolved — while its cluster is not reporting or its pod's node is NotReady.

ALTER TABLE alert_states ADD COLUMN held boolean NOT NULL DEFAULT false;
