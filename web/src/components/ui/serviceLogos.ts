// SPDX-License-Identifier: AGPL-3.0-only
import { type FunctionalComponent, h } from 'vue';
import elasticsearchUrl from '@/assets/brands/elasticsearch.svg';
import kafkaUrl from '@/assets/brands/kafka.svg';
import mongodbUrl from '@/assets/brands/mongodb.svg';
import mysqlUrl from '@/assets/brands/mysql.svg';
import nginxUrl from '@/assets/brands/nginx.svg';
import phpUrl from '@/assets/brands/php.svg';
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
  'php-fpm': phpUrl,
};

/**
 * Logos in one colour (Kafka's is white): drawn in the theme's text colour through a mask, so
 * they show on a light page too (ADR-229). The coloured ones keep their brand colours.
 */
export const MONO_LOGOS = new Set(['kafka']);

/** <ServiceLogo type="redis" class="size-8" /> */
export const ServiceLogo: FunctionalComponent<{ type: string }> = (props, { attrs }) => {
  const url = SERVICE_LOGO_URL[props.type] ?? '';
  if (MONO_LOGOS.has(props.type)) {
    const mask = `url("${url}") center / contain no-repeat`;
    return h('span', {
      'aria-hidden': 'true',
      'data-logo': props.type,
      'data-mono': '',
      ...attrs,
      class: ['inline-block shrink-0 bg-current text-text', attrs.class],
      style: { mask, WebkitMask: mask },
    });
  }
  return h('img', {
    src: url,
    alt: '',
    'data-logo': props.type,
    draggable: false,
    ...attrs,
    class: ['object-contain', attrs.class],
  });
};
ServiceLogo.props = ['type'];
ServiceLogo.inheritAttrs = false;
