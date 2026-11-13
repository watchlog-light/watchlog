-- Up Migration
-- Traefik (ADR-165): the `traefik` integration type.
ALTER TABLE integrations DROP CONSTRAINT integrations_type_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_type_check
  CHECK (type IN ('redis', 'postgres', 'nginx', 'rabbitmq', 'mysql', 'mongodb', 'traefik', 'elasticsearch'));
