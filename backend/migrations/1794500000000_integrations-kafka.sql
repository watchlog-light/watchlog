-- Up Migration
-- Kafka (ADR-166): the `kafka` integration type.
ALTER TABLE integrations DROP CONSTRAINT integrations_type_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_type_check
  CHECK (type IN ('redis', 'postgres', 'nginx', 'rabbitmq', 'mysql', 'mongodb', 'traefik', 'kafka', 'elasticsearch'));
