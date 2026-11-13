// SPDX-License-Identifier: AGPL-3.0-only
// The kubectl manifest behind an install code (ADR-176): the agent chart rendered once by
// scripts/render-install-manifest.sh (backend/assets/install-manifest.yaml, checked in CI
// against a fresh render), with its placeholders filled per request: the ingest address,
// the cluster token, the images, and a new pod map CA and certificate.
import { readFileSync } from 'node:fs';
import { podMapCertificates } from './x509.js';

const ASSET = new URL('../../../assets/install-manifest.yaml', import.meta.url);
const TOKEN_B64 = Buffer.from('WATCHLOG_INSTALL_TOKEN').toString('base64');

let template: string | undefined;
/** The rendered chart; read once. */
export function manifestTemplate(): string {
  template ??= readFileSync(ASSET, 'utf8');
  return template;
}

/** The cluster-agent's service host, from the node agents' pod map URL in the template. */
export function podMapService(text = manifestTemplate()): string {
  const m = /WATCHLOG_PODMAP_URL\n\s+value: https:\/\/([a-z0-9.-]+):\d+/.exec(text);
  if (!m) throw new Error('install manifest: WATCHLOG_PODMAP_URL not found');
  return m[1]!;
}

/** `ghcr.io/watchlog-light/agent:0.6.0` → registry `ghcr.io/watchlog-light`, tag `0.6.0`. */
export function splitAgentImage(image: string): { registry: string; tag: string } {
  const m = /^(.+)\/agent(?::([\w.-]+))?$/.exec(image);
  if (!m) throw new Error(`install manifest: the agent image ${image} doesn't end in /agent`);
  return { registry: m[1]!, tag: m[2] ?? 'latest' };
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** The manifest for one cluster: its token, where to push, and which images to run. */
export function installManifest(opts: { token: string; endpoint: string; image: string }): string {
  const { registry, tag } = splitAgentImage(opts.image);
  const certs = podMapCertificates(podMapService());
  // The endpoint is double-quoted by the chart; JSON's quoting is valid YAML there.
  const endpoint = JSON.stringify(opts.endpoint).slice(1, -1);
  return manifestTemplate()
    .replace(`token: ${TOKEN_B64}`, () => `token: ${b64(opts.token)}`)
    .replaceAll('WATCHLOG_INSTALL_ENDPOINT', () => endpoint)
    .replaceAll('WATCHLOG_INSTALL_REGISTRY', () => registry)
    .replaceAll('WATCHLOG_INSTALL_TAG', () => tag)
    .replace('WATCHLOG_PODMAP_CA_CRT', () => b64(certs.caCrt))
    .replace('WATCHLOG_PODMAP_TLS_CRT', () => b64(certs.tlsCrt))
    .replace('WATCHLOG_PODMAP_TLS_KEY', () => b64(certs.tlsKey));
}
