-- Up Migration
-- Change events from outside (1.0.0, ADR-238): a deploy from CI, a config change, a migration,
-- sent with an own-metrics token. A marker of its own kind, so charts, "Changed around then"
-- and probable cause read it with the changes WatchLog sees itself.
ALTER TABLE change_markers DROP CONSTRAINT change_markers_kind_check;
ALTER TABLE change_markers
  ADD CONSTRAINT change_markers_kind_check CHECK (
    kind IN ('rollout', 'image', 'scale', 'node', 'namespace', 'recreate', 'compose', 'external')
  );

-- Down Migration
DELETE FROM change_markers WHERE kind = 'external';
ALTER TABLE change_markers DROP CONSTRAINT change_markers_kind_check;
ALTER TABLE change_markers
  ADD CONSTRAINT change_markers_kind_check CHECK (
    kind IN ('rollout', 'image', 'scale', 'node', 'namespace', 'recreate', 'compose')
  );
