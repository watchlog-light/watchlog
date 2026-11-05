-- Up Migration
-- Docker parity: change markers for Docker fleets. A container re-created (same name,
-- new container), and a Compose project brought up or down on a host. Image changes
-- use the existing 'image' kind.

ALTER TABLE change_markers DROP CONSTRAINT change_markers_kind_check;
ALTER TABLE change_markers ADD CONSTRAINT change_markers_kind_check
  CHECK (kind IN ('rollout', 'image', 'scale', 'node', 'recreate', 'compose'));
