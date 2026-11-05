-- Up Migration
-- Phase 2 slice 2: Kubernetes objects (ADR-055). snapshot_id is the cluster-agent
-- snapshot an object was last seen in (snapshot chunks and deltas carry it); the
-- final chunk of a snapshot marks objects of its kinds with another id deleted.

ALTER TABLE objects ADD COLUMN snapshot_id text CHECK (length(snapshot_id) <= 64);
CREATE INDEX objects_cluster_source_kind_live_idx ON objects (cluster_id, source, kind) WHERE deleted_at IS NULL;
