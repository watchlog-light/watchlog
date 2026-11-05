-- Up Migration
-- Cluster pages redesign: the list of system namespaces, hidden by default on the
-- Workloads page and in the overview's top workloads (Settings → General).

ALTER TABLE server_settings DROP CONSTRAINT server_settings_key_check;
ALTER TABLE server_settings ADD CONSTRAINT server_settings_key_check
  CHECK (key IN ('general', 'smtp', 'telegram', 'namespaces'));
