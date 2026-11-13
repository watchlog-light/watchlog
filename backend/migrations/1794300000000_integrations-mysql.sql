-- Up Migration
-- MySQL and MariaDB (ADR-163): one integration type, `mysql`, for both servers.
ALTER TABLE integrations DROP CONSTRAINT integrations_type_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_type_check
  CHECK (type IN ('redis', 'postgres', 'nginx', 'rabbitmq', 'mysql', 'mongodb', 'elasticsearch'));

-- "90%" without a space in the default service rules' names (v0.5 item 10), where the
-- name is still the shipped one.
UPDATE alert_rules SET name = 'Redis memory above 90% of maxmemory'
  WHERE default_key = 'redis_memory_high' AND name = 'Redis memory above 90 % of maxmemory';
UPDATE alert_rules SET name = 'PostgreSQL connections above 90% of max_connections'
  WHERE default_key = 'postgres_connections_high' AND name = 'PostgreSQL connections above 90 % of max_connections';
UPDATE alert_rules SET name = 'Nginx 5xx above 5%'
  WHERE default_key = 'nginx_5xx_high' AND name = 'Nginx 5xx above 5 %';
