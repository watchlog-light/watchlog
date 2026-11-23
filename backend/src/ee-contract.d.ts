// SPDX-License-Identifier: AGPL-3.0-only
// What the core gives an Enterprise module (ee/backend, ADR-232), and what a module gives
// back. Types only: ee/backend imports this file with `import type`, so it compiles on its
// own and the core never imports ee/'s code; at run time the core finds ee/backend's entry
// (ee.ts) and calls each module's `register`. The core builds and runs with ee/ deleted.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// The schema options the core's routes use (`hide`, `tags`), for ee's routes too.
import '@fastify/swagger';

/** A count of units an Enterprise licence includes, from a module (network devices). */
export interface EeUnitSource {
  name: string;
  daily(db: unknown, fromMs: number, toMs: number): Promise<Map<string, number>>;
}

type PreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply | undefined>;

export interface EeHost {
  edition: 'community' | 'cloud';
  demoMode: boolean;
  /** The core's sign-in check (a session or an API token), as every route uses it. */
  requireUser(): PreHandler;
  /**
   * A preHandler for the module's routes: 404 when the feature isn't licensed here (as if the
   * route didn't exist), 403 `license-ended` when its licence ended, else on. Read per request,
   * so a key pasted in Settings works at once.
   */
  requireFeature(feature: string): PreHandler;
  /** Whether an org has a feature now (Cloud: its Pro plan; self-hosted: the licence). */
  hasFeature(orgId: string, feature: string): Promise<boolean>;
  /** Adds the module's devices to the licence's unit count (license/units.ts). */
  registerUnitSource(source: EeUnitSource): void;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

export interface EeBackendModule {
  /** A short name, for logs: "network". */
  name: string;
  /** The licence feature that turns the module on: "network". */
  feature: string;
  /** Registers the module's routes under /api/v1, each behind host.requireFeature. */
  register(api: FastifyInstance, host: EeHost): Promise<void>;
}
