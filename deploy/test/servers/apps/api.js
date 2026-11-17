// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable @typescript-eslint/no-require-imports -- a plain Node app that pm2 runs in the Servers tests */
// A Node app run under pm2 in the Servers tests (two apps: api on :8092, mailer without a port).
const http = require('http');
const port = Number(process.argv[2] || 0);
if (port) http.createServer((_q, r) => r.end('api ok\n')).listen(port);
else setInterval(() => {}, 1000);
