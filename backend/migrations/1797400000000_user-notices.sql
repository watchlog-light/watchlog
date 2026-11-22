-- Up Migration
-- Notices a user has dismissed (0.13.0, ADR-230): the Overview's "WatchLog found 12
-- certificates and 9 scheduled jobs on its own" card shows once per user and per cluster or
-- fleet, and is gone for good after any of its buttons or ×. `firstFind` lists the clusters.
ALTER TABLE users ADD COLUMN notices jsonb NOT NULL DEFAULT '{}'::jsonb;
