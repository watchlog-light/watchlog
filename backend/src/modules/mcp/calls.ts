// SPDX-License-Identifier: AGPL-3.0-only
// The MCP call log (ADR-127): one row per tool call, never the output. Settings → API
// tokens shows a token's last 50 calls and its count over 30 days; the alert-worker
// deletes rows older than 30 days.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';

export const MCP_CALLS_KEPT_MS = 30 * 86_400_000;
/** Calls shown per token in Settings → API tokens. */
export const MCP_CALLS_SHOWN = 50;
export const MCP_ARGS_MAX = 200;

export type McpCallStatus = 'ok' | 'truncated' | 'rate_limited' | 'error';

/** A call as Settings → API tokens shows it (the web's McpCall). */
export interface McpCallView {
  at: string;
  tool: string;
  args: string;
  status: McpCallStatus;
  durationMs: number;
  bytes: number;
}

export async function recordMcpCall(
  db: Database,
  call: {
    tokenId: string;
    orgId: string;
    tool: string;
    args: string;
    status: McpCallStatus;
    durationMs: number;
    bytes: number;
    at: Date;
  },
): Promise<void> {
  await db
    .insertInto('mcp_calls')
    .values({
      id: newId(),
      token_id: call.tokenId,
      org_id: call.orgId,
      at: call.at,
      tool: call.tool.slice(0, 64),
      args: call.args.slice(0, MCP_ARGS_MAX),
      status: call.status,
      duration_ms: Math.max(0, Math.round(call.durationMs)),
      bytes: Math.max(0, call.bytes),
    })
    .execute();
}

/** A token's latest calls, newest first. */
export async function recentMcpCalls(db: Database, tokenId: string): Promise<McpCallView[]> {
  const rows = await db
    .selectFrom('mcp_calls')
    .select(['at', 'tool', 'args', 'status', 'duration_ms', 'bytes'])
    .where('token_id', '=', tokenId)
    .orderBy('at', 'desc')
    .orderBy('id', 'desc')
    .limit(MCP_CALLS_SHOWN)
    .execute();
  return rows.map((r) => ({
    at: new Date(r.at).toISOString(),
    tool: r.tool,
    args: r.args,
    status: r.status as McpCallStatus,
    durationMs: r.duration_ms,
    bytes: r.bytes,
  }));
}

/** Tool calls per token in the 30 days before `now`. */
export async function countMcpCalls(
  db: Database,
  tokenIds: string[],
  now: Date,
): Promise<Map<string, number>> {
  if (tokenIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('mcp_calls')
    .select(['token_id', sql<string>`count(*)`.as('n')])
    .where('token_id', 'in', tokenIds)
    .where('at', '>', new Date(now.getTime() - MCP_CALLS_KEPT_MS))
    .groupBy('token_id')
    .execute();
  return new Map(rows.map((r) => [r.token_id, Number(r.n)]));
}

/** Deletes calls older than 30 days; the number deleted. */
export async function deleteOldMcpCalls(db: Database, now: Date): Promise<number> {
  const res = await db
    .deleteFrom('mcp_calls')
    .where('at', '<', new Date(now.getTime() - MCP_CALLS_KEPT_MS))
    .executeTakeFirst();
  return Number(res.numDeletedRows);
}
