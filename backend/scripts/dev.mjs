// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm dev` for the backend: migrate, then the API server and the alert-worker, both
// restarted on file changes. Ctrl-C stops both.
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const env = { ...process.env, NODE_ENV: 'development' };
const tsx = (args, extra = {}) =>
  spawn('tsx', args, { stdio: 'inherit', env: { ...env, ...extra } });

const migrate = spawnSync('tsx', ['src/migrate.ts'], { stdio: 'inherit', env });
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const children = [
  tsx(['watch', 'src/server.ts']),
  // Links in dev alert messages point at the Vite dev server.
  tsx(['watch', 'src/alert-worker.ts'], {
    WATCHLOG_PUBLIC_URL:
      process.env.WATCHLOG_PUBLIC_URL ??
      `http://localhost:${process.env.WATCHLOG_WEB_PORT ?? 4088}`,
  }),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
for (const c of children) c.on('exit', (code) => stop(code ?? 0));
