-- Up Migration
-- Server fleets replace Docker fleets (ADR-207, 0.9.0): the kind is renamed, nothing else.
-- Tokens, rules, alerts, egress, baselines, usage and billing keep their cluster ids, and
-- the series keep their labels (`host` names the server), so history continues.
ALTER TABLE clusters DROP CONSTRAINT IF EXISTS clusters_kind_check;
UPDATE clusters SET kind = 'server' WHERE kind = 'docker';
ALTER TABLE clusters ADD CONSTRAINT clusters_kind_check CHECK (kind IN ('kubernetes', 'server'));
