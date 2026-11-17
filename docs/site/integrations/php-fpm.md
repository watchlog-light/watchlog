---
title: PHP-FPM
description: Monitor PHP-FPM pools on Linux servers, Docker and Kubernetes with WatchLog: busy and idle workers, requests waiting, pm.max_children reached, requests a second and request time, from each pool's status page.
---

# PHP-FPM

WatchLog finds PHP-FPM on servers by its unit (`php8.3-fpm.service`) or its pools
(`pool www`), and in Docker and Kubernetes from the official image's `-fpm` tags and
`bitnami/php-fpm`. Open **Applications** and press **Monitor**: PHP-FPM needs no user or
password. PHP 7.4 and later.

## What it needs

Each pool's status page. Add two lines to the pool's configuration
(`/etc/php/8.3/fpm/pool.d/www.conf` on Debian and Ubuntu, `/etc/php-fpm.d/www.conf` on RHEL),
then reload PHP-FPM:

```ini
pm.status_path = /status
; when the pool listens on a socket: a status listener on loopback
pm.status_listen = 127.0.0.1:9001
```

```bash
sudo systemctl reload php8.3-fpm
```

WatchLog reads the page over FastCGI, on the pool's own TCP port or on the status listener,
once a scrape. Nothing goes through your web server. Without the lines, the page says what to
add, and the service isn't reported down.

From each worker WatchLog reads only numbers (how long its current or last request took, and
its memory). Request URIs, query strings, scripts and users never leave the server.

## The page

- **Overview:** busy workers out of all, requests waiting, requests a second, times every
  worker was busy (pm.max_children reached) and slow requests in the last 24 hours; workers busy
  and idle, the queue and requests over time.
- **Requests:** request time (p95 and the slowest), pm.max_children reached and slow requests,
  the largest request's memory, and the most workers busy at once.

## Default alerts

| Alert                           | When                                              |
| ------------------------------- | ------------------------------------------------- |
| PHP-FPM reached pm.max_children | every worker was busy at least once in 10 minutes |
| Requests waiting for a worker   | requests wait for 5 minutes                       |
| Workers above 90 % busy         | for 10 minutes                                    |

## What WatchLog says

- every worker was busy N times in the last 10 minutes, and how many requests wait;
- requests are waiting for a free worker;
- the workers are almost all busy;
- requests slower than `request_slowlog_timeout`;
- the status page is off, and how to turn it on.

## Questions

- **More than one pool?** Each pool is its own service in WatchLog, with its own status
  listener port.
- **Kubernetes or Docker?** Set `pm.status_path` in the image's pool configuration; WatchLog
  reads it on the pool's port (9000).
