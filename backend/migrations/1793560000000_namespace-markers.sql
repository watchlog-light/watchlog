-- Up Migration
-- The overview marks a namespace created after the first snapshot (kind 'namespace',
-- ADR-110), but the kind check never allowed it: every objects delta with a new
-- namespace failed, and the cluster-agent kept retrying it, holding back later changes.

ALTER TABLE change_markers DROP CONSTRAINT change_markers_kind_check;
ALTER TABLE change_markers ADD CONSTRAINT change_markers_kind_check
  CHECK (kind IN ('rollout', 'image', 'scale', 'node', 'namespace', 'recreate', 'compose'));
