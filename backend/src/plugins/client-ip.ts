// SPDX-License-Identifier: AGPL-3.0-only
// What a proxy in front may tell the backend (ADR-123): the visitor's address (for rate
// limits) and whether the visitor came over https (for the session cookie). Both are
// believed only from a trusted proxy, by the socket's peer address, so a client that
// reaches the backend another way cannot claim either.
//
// The web image's Caddy keeps X-Forwarded-For to its own peer and, from a private-range
// peer, passes X-Forwarded-Proto and X-Real-IP through unchanged (web/Caddyfile,
// measured with caddy 2.11).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BlockList, isIP } from 'node:net';

declare module 'fastify' {
  interface FastifyRequest {
    /** The visitor's address: the client-IP header from a trusted proxy, else request.ip. */
    clientIp: string;
    /** Whether the session cookie gets the Secure attribute (WATCHLOG_COOKIE_SECURE). */
    secureCookie: boolean;
  }
}

/** Loopback and private ranges: the web container in Compose and Kubernetes. */
export const DEFAULT_TRUSTED_PROXIES = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
];

export type CookieSecure = 'auto' | 'always' | 'never';

/** A list of CIDRs (or single addresses); throws on anything else. */
export function parseTrustedProxies(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const raw of cidrs) {
    const [addr = '', bits] = raw.trim().split('/');
    const family = isIP(addr);
    const prefix = bits === undefined ? (family === 6 ? 128 : 32) : Number(bits);
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) {
      throw new Error(`not an address or CIDR range: "${raw}"`);
    }
    list.addSubnet(addr, prefix, family === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

/** The socket's peer, with an IPv4-mapped IPv6 address ("::ffff:10.0.0.1") as IPv4. */
export function peerAddress(request: FastifyRequest): string {
  const raw = request.socket.remoteAddress ?? '';
  return raw.startsWith('::ffff:') && isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
}

export function isTrusted(trusted: BlockList, address: string): boolean {
  const family = isIP(address);
  return family !== 0 && trusted.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

const firstValue = (request: FastifyRequest, header: string) => {
  const raw = request.headers[header.toLowerCase()];
  return (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
};

export interface ProxyOptions {
  /** A header a trusted proxy sets to the visitor's address (WATCHLOG_CLIENT_IP_HEADER). */
  clientIpHeader?: string;
  trustedProxies: BlockList;
  cookieSecure: CookieSecure;
}

/** The visitor's address: the header from a trusted peer; from any other peer, the peer. */
export function clientIpOf(request: FastifyRequest, opts: ProxyOptions): string {
  if (!opts.clientIpHeader) return request.ip;
  const peer = peerAddress(request);
  if (!isTrusted(opts.trustedProxies, peer)) return peer || request.ip;
  const named = firstValue(request, opts.clientIpHeader);
  return named && isIP(named) ? named : request.ip;
}

/**
 * Secure when the request came over https: a TLS socket, or X-Forwarded-Proto: https from
 * a trusted proxy. Plain http (local development, a LAN install) keeps a cookie it can use.
 */
export function secureCookieFor(request: FastifyRequest, opts: ProxyOptions): boolean {
  if (opts.cookieSecure !== 'auto') return opts.cookieSecure === 'always';
  if ((request.socket as { encrypted?: boolean }).encrypted) return true;
  return (
    isTrusted(opts.trustedProxies, peerAddress(request)) &&
    firstValue(request, 'x-forwarded-proto')?.toLowerCase() === 'https'
  );
}

export function registerClientIp(app: FastifyInstance, opts: ProxyOptions): void {
  app.decorateRequest('clientIp', '');
  app.decorateRequest('secureCookie', false);
  app.addHook('onRequest', async (request) => {
    request.clientIp = clientIpOf(request, opts);
    request.secureCookie = secureCookieFor(request, opts);
  });
}
