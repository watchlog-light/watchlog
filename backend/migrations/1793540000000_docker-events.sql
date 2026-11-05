-- Up Migration
-- Docker parity: Docker events (die, oom, health, create/destroy, image pull) are stored
-- with the Kubernetes events, same partitions and retention (ADR-061); `host` names the
-- Docker host. Kubernetes events leave it empty.

ALTER TABLE k8s_events ADD COLUMN host text NOT NULL DEFAULT '';
