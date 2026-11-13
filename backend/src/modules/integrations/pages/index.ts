// SPDX-License-Identifier: AGPL-3.0-only
// The service pages by type (ADR-135). Each integration replaces the generic page with
// its own as it lands (Redis, PostgreSQL, Nginx, RabbitMQ, MySQL; MongoDB, Traefik and Kafka in v0.5).
import type { IntegrationType } from '../collector-config.js';
import { genericPage } from './generic.js';
import { mysqlPage } from './mysql.js';
import { nginxPage } from './nginx.js';
import { postgresPage } from './postgres.js';
import { rabbitmqPage } from './rabbitmq.js';
import { redisPage } from './redis.js';
import type { IntegrationPage } from './types.js';

const PAGES: Partial<Record<IntegrationType, IntegrationPage>> = {
  mysql: mysqlPage,
  nginx: nginxPage,
  postgres: postgresPage,
  rabbitmq: rabbitmqPage,
  redis: redisPage,
};

export function pageOf(type: IntegrationType): IntegrationPage {
  return PAGES[type] ?? genericPage;
}

export { connectedTo, type ConnectedResult } from './connected.js';
export { PAGE_RANGES } from './query.js';
export { sortReasons, statusReasons } from './reasons.js';
export type * from './types.js';
