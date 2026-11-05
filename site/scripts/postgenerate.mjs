// SPDX-License-Identifier: AGPL-3.0-only
// After `nuxt generate`: the prerendered not-found page becomes 404.html (nginx's
// error page), the SPA fallbacks go (there is no client app to fall back to), and the
// Docker install's compose.yaml is published once the repository is public.
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { site } from '../site.config.ts';

const out = fileURLToPath(new URL('../.output/public/', import.meta.url));
copyFileSync(`${out}not-found/index.html`, `${out}404.html`);
rmSync(`${out}not-found`, { recursive: true });
rmSync(`${out}200.html`, { force: true });
if (site.repoPublic) {
  copyFileSync(
    fileURLToPath(new URL('../../deploy/docker/compose.yaml', import.meta.url)),
    `${out}compose.yaml`,
  );
} else if (existsSync(`${out}compose.yaml`)) {
  rmSync(`${out}compose.yaml`);
}
console.log(`postgenerate: 404.html${site.repoPublic ? ', compose.yaml' : ''}`);
