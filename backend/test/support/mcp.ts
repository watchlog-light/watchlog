// SPDX-License-Identifier: AGPL-3.0-only
// An MCP client for tests: the official SDK client over real HTTP, with an API token of the
// signed-in user (ADR-127).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { TestContext } from '../helpers.js';

/** A tool's JSON answer: assertions read it field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolJson = any;

export interface McpTestClient {
  client: Client;
  token: string;
  tokenId: string;
  /** Calls a tool; the parsed JSON of its text answer, and whether it is an error. */
  call(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ isError: boolean; data: ToolJson; text: string }>;
  close(): Promise<void>;
}

export async function mcpClient(ctx: TestContext, cookie: string): Promise<McpTestClient> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/api-tokens',
    cookies: { wl_session: cookie },
    payload: { name: 'MCP test' },
  });
  if (created.statusCode !== 201) throw new Error(`token: ${created.body}`);
  const token = created.json().value as string;
  const address = ctx.app.server.listening
    ? `http://127.0.0.1:${(ctx.app.server.address() as { port: number }).port}`
    : await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const client = new Client(
    { name: 'watchlog-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return {
    client,
    token,
    tokenId: created.json().token.id as string,
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[])[0]!.text;
      return { isError: res.isError === true, data: JSON.parse(text), text };
    },
    close: () => client.close(),
  };
}
