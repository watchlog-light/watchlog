// SPDX-License-Identifier: AGPL-3.0-only
// The live demo's public MCP token (ADR-130). Its value comes from the seed file, so demo
// mode is never turned off to make it; it is an ordinary read token of the demo viewer
// account, published on the site and in the docs. It works only in demo mode: started
// without demo mode, the backend deletes every token of the demo account.
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { sha256 } from '../../lib/tokens.js';
import { displayPrefix } from '../api-tokens/tokens.js';
import { DEMO_USER_EMAIL } from './constants.js';

export const DEMO_MCP_TOKEN_NAME = 'Live demo: public MCP token';

/** ADR-130's limits on the public token's tool calls. */
export const DEMO_MCP_VISITOR_CALLS_PER_MINUTE = 30;
export const DEMO_MCP_TOTAL_CALLS_PER_MINUTE = 600;

export interface DemoMcpLimits {
  visitorCallsPerMinute: number;
  totalCallsPerMinute: number;
}

interface Logger {
  info(obj: object, msg: string): void;
}

/**
 * Makes the demo account's tokens match the seed: in demo mode, exactly the public token
 * (created once, kept across restarts; a new value in the seed replaces the old one);
 * without demo mode, none.
 */
export async function syncDemoMcpToken(
  db: Database,
  opts: { demoMode: boolean; token: string | undefined },
  log: Logger,
): Promise<void> {
  const user = await db
    .selectFrom('users as u')
    .innerJoin('memberships as m', 'm.user_id', 'u.id')
    .select(['u.id', 'm.org_id'])
    .where('u.email', '=', DEMO_USER_EMAIL)
    .executeTakeFirst();
  if (!user) return;
  const wanted = opts.demoMode && opts.token ? sha256(opts.token) : null;
  await db.transaction().execute(async (trx) => {
    const removed = await trx
      .deleteFrom('api_tokens')
      .where('user_id', '=', user.id)
      .$if(wanted !== null, (q) => q.where('token_hash', '!=', wanted!))
      .executeTakeFirst();
    if (Number(removed.numDeletedRows) > 0) {
      log.info({ removed: Number(removed.numDeletedRows) }, 'demo MCP token: old tokens removed');
    }
    if (!wanted) return;
    const exists = await trx
      .selectFrom('api_tokens')
      .select('id')
      .where('token_hash', '=', wanted)
      .executeTakeFirst();
    if (exists) return;
    await trx
      .insertInto('api_tokens')
      .values({
        id: newId(),
        org_id: user.org_id,
        user_id: user.id,
        name: DEMO_MCP_TOKEN_NAME,
        token_hash: wanted,
        prefix: displayPrefix(opts.token!),
        scope: 'read',
        expires_at: null,
      })
      .execute();
    log.info({ prefix: displayPrefix(opts.token!) }, 'demo MCP token: created');
  });
}
