// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable @typescript-eslint/no-require-imports -- a plain Node app that pm2 runs in the Servers tests */
// A Node app run under pm2 in the Servers tests (two apps: api serves :8092, mailer calls it
// every 2 seconds, so the pm2 groups have connections to attribute).
const http = require('http');
const port = Number(process.argv[2] || 0);
const target = process.argv[3];
if (port) http.createServer((_q, r) => r.end('api ok\n')).listen(port);
else if (target)
  setInterval(() => {
    http.get(target, (r) => r.resume()).on('error', () => {});
  }, 2000);
else setInterval(() => {}, 1000);
