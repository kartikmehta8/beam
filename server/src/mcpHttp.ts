/**
 * @file Hosted MCP over streamable HTTP, so an external agent (Claude Code,
 * Codex) connects with a URL instead of running the stdio server itself:
 *
 *   claude mcp add --transport http beam https://<host>/mcp/<wallet>
 *
 * The wallet to propose payments for rides in the path, so one hosted server
 * serves every user. Like stdio MCP, these tools only PROPOSE intents with
 * `origin: 'mcp'` — nothing here signs or sends, and every payment still needs
 * the human's World ID approval on the phone.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { Hono } from 'hono';
import type { Address } from 'viem';
import type { ChainClient } from './chain';
import type { EnsReader } from './ens';
import { toChecksumAddress } from './intent';
import type { Env } from './http';
import { createMcpServer, type McpDeps } from './mcp';
import type { Network } from './network';

/** Chain/ENS/network/contract the MCP tools read; wallet comes from the URL. */
export type McpHttpDeps = Omit<McpDeps, 'wallet'> & { chain: ChainClient; ens: EnsReader | null; network: Network; beamPay: Address };

/**
 * Mounts `POST|GET|DELETE /mcp/:wallet`. Stateless: a fresh server + transport
 * per request, so there is no session map to leak; the tools hold no state
 * between calls. JSON responses (not SSE) keep it robust through tunnels.
 * ponytail: unauthenticated — the World ID approval on the phone is the real
 * gate, not a bearer token. Add a token header if you expose this widely.
 * @param app The Hono app.
 * @param deps Chain, ENS, network, contract and daily limit.
 */
export function mountMcpHttp(app: Hono<Env>, deps: McpHttpDeps): void {
  app.all('/mcp/:wallet', async (c) => {
    const wallet = toChecksumAddress(c.req.param('wallet'));
    if (!wallet) return c.json({ error: 'BAD_WALLET', message: 'Path must be /mcp/<0x-wallet-address>.' }, 400);

    const { incoming, outgoing } = c.env as unknown as HttpBindings;
    const server = createMcpServer({ ...deps, wallet });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    outgoing.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const body = c.req.method === 'POST' ? await c.req.json().catch(() => undefined) : undefined;
    await transport.handleRequest(incoming, outgoing, body);
    return RESPONSE_ALREADY_SENT;
  });
}
