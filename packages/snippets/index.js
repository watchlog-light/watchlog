// SPDX-License-Identifier: AGPL-3.0-only
// What a user copies to send their own metrics (see README.md): the push in six languages,
// Prometheus remote write, the scrape annotation as YAML and as a kubectl patch, and one
// counter on a /metrics page with each language's Prometheus client library.

/** Where a token's value goes until one is made. */
export const TOKEN_PLACEHOLDER = 'wl_mt_…';

/** The push snippets' languages, in the page's order. */
export const PUSH_LANGS = ['curl', 'cron', 'node', 'python', 'php', 'go'];
export const PUSH_LANG_NAMES = {
  curl: 'curl',
  cron: 'Bash in a cron job',
  node: 'Node.js',
  python: 'Python',
  php: 'PHP',
  go: 'Go',
};

/** The examples the docs and an untouched page show. */
export const PUSH_EXAMPLE = { name: 'orders_total', value: '1' };

/** A name that reads as a time ("last good backup"): its value is the clock's, not a count. */
export const isTimestampName = (name) => /_timestamp(_seconds)?$/.test(name);

const pushUrl = (endpoint) => `${String(endpoint).replace(/\/+$/, '')}/ingest/v1/metrics`;

/** The value as a JSON number; what isn't a number becomes 1 (the page says so beside the field). */
const number = (value) => {
  const n = Number(String(value).trim());
  return String(value).trim() !== '' && Number.isFinite(n) ? String(n) : '1';
};

/** What the push names as its owner: a server, or a workload as "namespace/name". */
const ownerPair = (owner) =>
  owner && owner.server
    ? ['server', owner.server]
    : owner && owner.workload
      ? ['workload', owner.workload]
      : null;

/** The body as one line of JSON, the keys in the order a person reads them. */
export function pushBody({ name, value, owner }) {
  const pair = ownerPair(owner);
  const parts = [`"name": ${JSON.stringify(name)}`, `"value": ${number(value)}`];
  if (pair) parts.push(`"${pair[0]}": ${JSON.stringify(pair[1])}`);
  return `{${parts.join(', ')}}`;
}

const shellSingle = (s) => s.replace(/'/g, `'\\''`);

/**
 * One value pushed, in `lang`. `o`: endpoint (the installation's ingest address), token, name,
 * value, owner ({server} or {workload: "namespace/name"}).
 */
export function pushSnippet(lang, o) {
  const url = pushUrl(o.endpoint);
  const token = o.token || TOKEN_PLACEHOLDER;
  const body = pushBody(o);
  const pair = ownerPair(o.owner);
  const name = JSON.stringify(o.name);
  const value = number(o.value);
  switch (lang) {
    case 'curl':
      return [
        `curl -sS -X POST ${url} \\`,
        `  -H "Authorization: Bearer ${token}" \\`,
        '  -H "Content-Type: application/json" \\',
        `  -d '${shellSingle(body)}'`,
      ].join('\n');
    case 'cron': {
      const stamp = isTimestampName(o.name);
      const inner = [`\\"name\\": \\"${o.name}\\"`, '\\"value\\": $value'];
      if (pair) inner.push(`\\"${pair[0]}\\": \\"${pair[1]}\\"`);
      return [
        '#!/usr/bin/env bash',
        '# push.sh: run it from cron, for example every five minutes:',
        '#   */5 * * * * /usr/local/bin/push.sh',
        'set -euo pipefail',
        stamp
          ? 'value=$(date +%s)   # now: run this after the job succeeded'
          : `value=${value}   # your number, for example: value=$(ls /var/spool/jobs | wc -l)`,
        `curl -sS --fail -X POST ${url} \\`,
        `  -H "Authorization: Bearer ${token}" \\`,
        '  -H "Content-Type: application/json" \\',
        `  -d "{${inner.join(', ')}}"`,
      ].join('\n');
    }
    case 'node':
      return [
        '// Node.js 18 or later: fetch is built in.',
        `await fetch(${JSON.stringify(url)}, {`,
        '  method: "POST",',
        `  headers: { Authorization: "Bearer ${token}", "Content-Type": "application/json" },`,
        `  body: JSON.stringify({ name: ${name}, value: ${value}${
          pair ? `, ${pair[0]}: ${JSON.stringify(pair[1])}` : ''
        } }),`,
        '});',
      ].join('\n');
    case 'python':
      return [
        'import json, urllib.request',
        '',
        'req = urllib.request.Request(',
        `    ${JSON.stringify(url)},`,
        `    data=json.dumps({"name": ${name}, "value": ${value}${
          pair ? `, "${pair[0]}": ${JSON.stringify(pair[1])}` : ''
        }}).encode(),`,
        `    headers={"Authorization": "Bearer ${token}", "Content-Type": "application/json"},`,
        ')',
        'urllib.request.urlopen(req)',
      ].join('\n');
    case 'php':
      return [
        '$context = stream_context_create(["http" => [',
        '  "method" => "POST",',
        `  "header" => "Authorization: Bearer ${token}\\r\\nContent-Type: application/json",`,
        `  "content" => json_encode(["name" => ${name}, "value" => ${value}${
          pair ? `, "${pair[0]}" => ${JSON.stringify(pair[1])}` : ''
        }]),`,
        ']]);',
        `file_get_contents(${JSON.stringify(url)}, false, $context);`,
      ].join('\n');
    case 'go':
      return [
        '// import "net/http" and "strings"',
        `body := strings.NewReader(\`${body}\`)`,
        `req, _ := http.NewRequest("POST", ${JSON.stringify(url)}, body)`,
        `req.Header.Set("Authorization", "Bearer ${token}")`,
        'req.Header.Set("Content-Type", "application/json")',
        'if res, err := http.DefaultClient.Do(req); err == nil {',
        '\tres.Body.Close()',
        '}',
      ].join('\n');
    default:
      throw new Error(`no push snippet in ${lang}`);
  }
}

/**
 * The snippet as a whole program its runtime can run (the tests do): what a snippet leaves to
 * the code around it (PHP's opening tag, Go's package and imports) is added, nothing else.
 */
export function pushProgram(lang, o) {
  const code = pushSnippet(lang, o);
  if (lang === 'php') return `<?php\n${code}\n`;
  if (lang === 'go') {
    const lines = code.split('\n').slice(1);
    return [
      'package main',
      '',
      'import (',
      '\t"net/http"',
      '\t"strings"',
      ')',
      '',
      'func main() {',
      ...lines.map((l) => `\t${l}`),
      '}',
      '',
    ].join('\n');
  }
  return `${code}\n`;
}

/** How each program is run, and its file's name: [file, command, ...arguments before the file]. */
export const PUSH_RUNNERS = {
  curl: ['push-curl.sh', 'bash'],
  cron: ['push.sh', 'bash'],
  node: ['push.mjs', 'node'],
  python: ['push.py', 'python3'],
  php: ['push.php', 'php'],
  go: ['push.go', 'go', 'run'],
};

/** Prometheus remote write, keeping only the metrics named. */
export function remoteWriteSnippet(endpoint, token) {
  return [
    'remote_write:',
    `  - url: ${String(endpoint).replace(/\/+$/, '')}/ingest/v1/write`,
    '    authorization:',
    `      credentials: ${token || TOKEN_PLACEHOLDER}`,
    '    write_relabel_configs:',
    '      # Send only what you want to see in WatchLog.',
    '      - source_labels: [__name__]',
    '        regex: "orders_.*|checkout_duration_seconds.*|queue_jobs_waiting"',
    '        action: keep',
  ].join('\n');
}

/** What a /metrics page looks like: four lines of the Prometheus text format. */
export const METRICS_SAMPLE = [
  '# TYPE orders_total counter',
  'orders_total{method="card"} 1842',
  '# TYPE queue_jobs_waiting gauge',
  'queue_jobs_waiting{queue="emails"} 12',
].join('\n');

const annotations = (port, path) => [
  ['watchlog.io/scrape', 'true'],
  ['watchlog.io/port', String(port || 8080)],
  ...(path && path !== '/metrics' ? [['watchlog.io/path', path]] : []),
];

/** The annotations that make a pod scraped, in the pod template. */
export function annotationSnippet(port, path) {
  const explicit = port !== undefined;
  return [
    'spec:',
    '  template:',
    '    metadata:',
    '      annotations:',
    ...(explicit
      ? annotations(port, path).map(([k, v]) => `        ${k}: "${v}"`)
      : [
          '        watchlog.io/scrape: "true"',
          '        watchlog.io/port: "8080"      # default: the first named port',
          '        watchlog.io/path: "/metrics"  # default',
        ]),
  ].join('\n');
}

/** The same annotations as one kubectl command on a workload's pod template. */
export function kubectlPatchSnippet({ namespace, kind, name, port, path }) {
  const a = annotations(port, path)
    .map(([k, v]) => `"${k}":"${v}"`)
    .join(',');
  return [
    `kubectl -n ${namespace} patch ${String(kind).toLowerCase()} ${name} --type merge \\`,
    `  -p '{"spec":{"template":{"metadata":{"annotations":{${a}}}}}}'`,
  ].join('\n');
}

/** "Add one to my app": the languages, in the page's order. */
export const EXPOSE_LANGS = ['node', 'python', 'go', 'php', 'java'];
export const EXPOSE_LANG_NAMES = {
  node: 'Node.js',
  python: 'Python',
  go: 'Go',
  php: 'PHP',
  java: 'Java',
};

/**
 * One counter, `orders_total`, on a /metrics page on port 9400, with the Prometheus client
 * library of each language (names, imports and calls checked against each library's docs on
 * 2026-11-26; PHP's is the community library prometheus.io lists, the others are official).
 */
const EXPOSE = {
  node: [
    '// npm install @prometheus-io/client   (the library that was "prom-client")',
    'const http = require("http");',
    'const client = require("@prometheus-io/client");',
    '',
    'const orders = new client.Counter({ name: "orders_total", help: "Orders created" });',
    '// where an order is created:',
    'orders.inc();',
    '',
    'http.createServer(async (req, res) => {',
    '  res.setHeader("Content-Type", client.register.contentType);',
    '  res.end(await client.register.metrics());',
    '}).listen(9400);',
  ],
  python: [
    '# pip install prometheus-client',
    'from prometheus_client import Counter, start_http_server',
    '',
    'orders = Counter("orders", "Orders created")  # exposed as orders_total',
    'start_http_server(9400)',
    '# where an order is created:',
    'orders.inc()',
  ],
  go: [
    '// go get github.com/prometheus/client_golang',
    'import (',
    '\t"net/http"',
    '',
    '\t"github.com/prometheus/client_golang/prometheus"',
    '\t"github.com/prometheus/client_golang/prometheus/promauto"',
    '\t"github.com/prometheus/client_golang/prometheus/promhttp"',
    ')',
    '',
    'var orders = promauto.NewCounter(prometheus.CounterOpts{Name: "orders_total", Help: "Orders created"})',
    '',
    'func main() {',
    '\t// where an order is created: orders.Inc()',
    '\thttp.Handle("/metrics", promhttp.Handler())',
    '\thttp.ListenAndServe(":9400", nil)',
    '}',
  ],
  php: [
    '// composer require promphp/prometheus_client_php',
    '// metrics.php, served at /metrics (APCu keeps the count between requests)',
    '$registry = new Prometheus\\CollectorRegistry(new Prometheus\\Storage\\APC());',
    '// where an order is created:',
    '$registry->getOrRegisterCounter("", "orders_total", "Orders created")->inc();',
    '',
    'header("Content-Type: " . Prometheus\\RenderTextFormat::MIME_TYPE);',
    'echo (new Prometheus\\RenderTextFormat())->render($registry->getMetricFamilySamples());',
  ],
  java: [
    '// Maven: io.prometheus:prometheus-metrics-core',
    '//    and io.prometheus:prometheus-metrics-exporter-httpserver',
    'import io.prometheus.metrics.core.metrics.Counter;',
    'import io.prometheus.metrics.exporter.httpserver.HTTPServer;',
    '',
    'Counter orders = Counter.builder().name("orders_total").help("Orders created").register();',
    'HTTPServer server = HTTPServer.builder().port(9400).buildAndStart();',
    '// where an order is created:',
    'orders.inc();',
  ],
};

export function exposeSnippet(lang) {
  const lines = EXPOSE[lang];
  if (!lines) throw new Error(`no /metrics snippet in ${lang}`);
  return lines.join('\n');
}
