// SPDX-License-Identifier: AGPL-3.0-only
import { type FunctionalComponent, h } from 'vue';
import elasticsearchUrl from '@/assets/brands/elasticsearch.svg';
import kafkaUrl from '@/assets/brands/kafka.svg';
import mongodbUrl from '@/assets/brands/mongodb.svg';
import mysqlUrl from '@/assets/brands/mysql.svg';
import nginxUrl from '@/assets/brands/nginx.svg';
import postgresUrl from '@/assets/brands/postgres.svg';
import rabbitmqUrl from '@/assets/brands/rabbitmq.svg';
import redisUrl from '@/assets/brands/redis.svg';
import traefikUrl from '@/assets/brands/traefik.svg';

// The monitored services' logos (Applications, SPEC §4.12): Simple Icons (CC0) in each
// brand's colour, noted in TRADEMARKS.md "Other marks". Decorative: the service's name is
// always written next to them.
export const SERVICE_LOGO_URL: Record<string, string> = {
  redis: redisUrl,
  postgres: postgresUrl,
  nginx: nginxUrl,
  rabbitmq: rabbitmqUrl,
  mysql: mysqlUrl,
  mongodb: mongodbUrl,
  traefik: traefikUrl,
  kafka: kafkaUrl,
  elasticsearch: elasticsearchUrl,
};

/** <ServiceLogo type="redis" class="size-8" /> */
export const ServiceLogo: FunctionalComponent<{ type: string }> = (props, { attrs }) =>
  h('img', {
    src: SERVICE_LOGO_URL[props.type] ?? '',
    alt: '',
    'data-logo': props.type,
    draggable: false,
    ...attrs,
    class: ['object-contain', attrs.class],
  });
ServiceLogo.props = ['type'];
ServiceLogo.inheritAttrs = false;
