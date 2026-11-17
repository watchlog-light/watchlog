// SPDX-License-Identifier: AGPL-3.0-only
// GET /install.sh (ADR-209): the server install script, with this WatchLog's ingest address
// and its own release as the defaults, so `curl -fsSL <address>/install.sh | sudo sh -s --
// --token …` installs agents that match the server. Every edition; the script is public
// (it holds no token). The binaries still come from GitHub Releases, checked against the
// release's checksums.
import { existsSync, readFileSync } from 'node:fs';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { Config } from '../../config.js';
import type { SettingsService } from '../settings/service.js';
import { installTarget } from '../clusters/install.js';

// In the image: assets/install.sh (the Dockerfile copies deploy/linux/install.sh there); in
// a checkout: deploy/linux/install.sh itself.
const CANDIDATES = [
  new URL('../../../assets/install.sh', import.meta.url),
  new URL('../../../../deploy/linux/install.sh', import.meta.url),
];
let template: string | undefined;
function script(): string | null {
  if (template === undefined) {
    const found = CANDIDATES.find((u) => existsSync(u));
    template = found ? readFileSync(found, 'utf8') : '';
  }
  return template || null;
}

/** A release version (0.9.0), not a development build: the default the script pins. */
const RELEASE = /^v?\d+\.\d+\.\d+$/;

/** The script with this install's defaults; the user's own flags still override them. */
export function renderInstallScript(base: string, endpoint: string, version: string): string {
  const out = base.replace(/^URL=\$\{WATCHLOG_URL:-[^}]*\}$/m, `URL=\${WATCHLOG_URL:-${endpoint}}`);
  if (!RELEASE.test(version)) return out;
  return out.replace(
    /^VERSION=\$\{WATCHLOG_VERSION:-\}$/m,
    `VERSION=\${WATCHLOG_VERSION:-${version.replace(/^v/, '')}}`,
  );
}

export const installScriptRoutes: FastifyPluginAsyncTypebox<{
  config: Config;
  settings: SettingsService;
}> = async (app, { config, settings }) => {
  const target = installTarget(config, settings);
  app.get(
    '/install.sh',
    { schema: { hide: true, summary: 'The server install script (ADR-209)' } },
    async (request, reply) => {
      const base = script();
      if (!base) return reply.code(404).send('The install script is not in this build.\n');
      const endpoint = await target.endpointFor(request);
      return reply
        .header('content-type', 'text/x-shellscript; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(renderInstallScript(base, endpoint, config.version));
    },
  );
};
