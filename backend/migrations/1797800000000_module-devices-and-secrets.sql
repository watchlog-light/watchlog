-- Up Migration
-- Enterprise modules (ADR-233): the devices a module counts as units (network devices), in
-- the same hourly usage rows as nodes and servers, so Cloud's bill (p95) and a licence's
-- count read one place; and the columns a module encrypts with the install's secret key, so
-- `rotate-secret-key` re-encrypts them too without knowing the module.
ALTER TABLE usage_hourly ADD COLUMN devices integer NOT NULL DEFAULT 0 CHECK (devices >= 0);

CREATE TABLE module_secret_columns (
  table_name text NOT NULL CHECK (table_name ~ '^[a-z_][a-z0-9_]*$'),
  id_column text NOT NULL CHECK (id_column ~ '^[a-z_][a-z0-9_]*$'),
  secret_column text NOT NULL CHECK (secret_column ~ '^[a-z_][a-z0-9_]*$'),
  PRIMARY KEY (table_name, secret_column)
);

-- Down Migration
DROP TABLE module_secret_columns;
ALTER TABLE usage_hourly DROP COLUMN devices;
