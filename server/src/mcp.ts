/**
 * @file Stdio MCP server exposing the same tools the phone agent uses, for
 * external agents (Claude Desktop). It only proposes intents; nothing here
 * can sign or send. Every intent gets `origin: 'mcp'`, so `EXTERNAL_AGENT`
 * always forces a World ID approval on the phone, and comes with a
 * `bubbleagent://review` link the phone re-validates from scratch.
 *
 * Env: the core settings (`BEAM_NETWORK`, RPC URLs, `ENS_CHAIN`, `ENS_RPC_URL`,
 * `BEAMPAY_ADDRESS`), `MCP_WALLET_ADDRESS` (required) and `MCP_DAILY_LIMIT`
 * (default 100, in the network's token). stdout carries the protocol, so
 * diagnostics go to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Address } from 'viem';
import { z } from 'zod';
import { encodeReviewLink } from './api';
import { createChainClient, createEnsClient, type ChainClient } from './chain';
import { loadCoreConfig } from './config';
import type { EnsReader } from './ens';
import { parseAmount, toChecksumAddress } from './intent';
import type { Network } from './network';
import { getTxStatus } from './tools/getTxStatus';
import { getWalletBalance } from './tools/getWalletBalance';
import { safeCaller } from './tools/index';
import { inspectRecipient } from './tools/inspectRecipient';
import { preparePayment } from './tools/preparePayment';
import { errorCode, type Tool, type ToolCtx, type ToolOutput } from './tools/tool';

/** Most context characters an external agent may attach (the review link's limit). */
export const MCP_CONTEXT_MAX = 2000;

/** What the MCP tools need. */
export type McpDeps = {
  chain: ChainClient;
  ens: EnsReader | null;
  network: Network;
  beamPay: Address;
  wallet: Address;
  dailyLimit: string;
};

/** `prepare_payment` input over MCP: the agent tool's input plus the text the payment is based on. */
export const mcpPrepareInput = preparePayment.input.extend({
  context: z
    .string()
    .min(1)
    .max(MCP_CONTEXT_MAX)
    .describe('The text the user shared that contains the recipient (and ideally the amount), copied exactly.'),
});

// ponytail: the daily limit is the static MCP_DAILY_LIMIT with no spend tracking; the phone re-checks real daily spend before signing.
/**
 * Fresh tool state per call. External agents have no chat with the user, so the pasted context is the only provenance source.
 * @param deps MCP deps.
 * @param contextText Text the external agent attached, or null.
 * @returns Tool context with origin "mcp".
 */
export function mcpCtx(deps: McpDeps, contextText: string | null): ToolCtx {
  return {
    // This grants proposal computation only; every external proposal still needs local World ID review.
    action: 'pay',
    chain: deps.chain,
    ens: deps.ens,
    network: deps.network,
    beamPay: deps.beamPay,
    wallet: deps.wallet,
    dailyRemaining: deps.dailyLimit,
    origin: 'mcp',
    context: contextText === null ? null : { source: 'clipboard', appLabel: 'MCP client', text: contextText },
    userTexts: [],
    intents: [],
    clarification: null,
    assessment: null,
  };
}

/**
 * `prepare_payment` for external agents: shared validation with origin "mcp"
 * (so `EXTERNAL_AGENT` and `payWithApproval` always apply), then the intent
 * JSON plus a review link for the phone.
 * @param deps MCP deps.
 * @param input Parsed MCP input.
 * @returns Tool output with `intent` and `reviewLink`, or a `{ error, message }`.
 */
export async function mcpPreparePayment(deps: McpDeps, input: z.infer<typeof mcpPrepareInput>): Promise<ToolOutput> {
  const { context, ...args } = input;
  const ctx = mcpCtx(deps, context);
  const out = await safeCaller(preparePayment)(ctx, args);
  const intent = ctx.intents[0];
  if (errorCode(out) || !intent) return out;
  const reviewLink = encodeReviewLink({ v: 1, intentId: intent.id, to: args.to.trim(), amount: args.amount.trim(), context });
  return { ...out, intent, reviewLink, next: 'Open reviewLink on the phone. The user reviews it and approves with World ID.' };
}

/**
 * Formats a tool output as an MCP tool result.
 * @param out Tool output.
 * @returns JSON text content, flagged as an error when the tool failed.
 */
const toResult = (out: ToolOutput) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(out) }],
  isError: errorCode(out) !== null,
});

/**
 * Builds the MCP server with Beam's read tools and `prepare_payment`.
 * @param deps Chain, ENS, network and the configured wallet.
 * @returns An unconnected `McpServer`.
 */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'beam', version: '2.0.0' });
  const readTools = [getWalletBalance, inspectRecipient, getTxStatus] as unknown as Tool<z.ZodObject>[];
  for (const tool of readTools) {
    const call = safeCaller(tool);
    server.registerTool(tool.name, { description: tool.description(deps.network), inputSchema: tool.input }, async (input: unknown) =>
      toResult(await call(mcpCtx(deps, null), input)),
    );
  }
  server.registerTool(
    preparePayment.name,
    {
      description:
        `${preparePayment.description(deps.network)} Pass the text the payment is based on as context. ` +
        'Returns intent JSON and a reviewLink for the Beam phone app; it never signs, and the user must approve with World ID.',
      inputSchema: mcpPrepareInput,
    },
    async (input) => toResult(await mcpPreparePayment(deps, input)),
  );
  return server;
}

/** Reads env, then serves MCP over stdio. */
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = process.env;
  const refuse = (reasons: string[]): never => {
    console.error(`Beam MCP refusing to start:\n- ${reasons.join('\n- ')}`);
    process.exit(1);
  };
  const core = loadCoreConfig(env);
  if (!core.ok) return refuse(core.errors);
  const config = core.config;
  const wallet = toChecksumAddress(env.MCP_WALLET_ADDRESS ?? '') ?? refuse(['MCP_WALLET_ADDRESS: must be a 0x address']);
  const dailyLimit = env.MCP_DAILY_LIMIT || '100';
  if (parseAmount(dailyLimit, config.network) === null) refuse([`MCP_DAILY_LIMIT: must be a ${config.network.symbol} decimal amount`]);
  const deps: McpDeps = {
    chain: createChainClient(config.network, config.rpcUrl),
    ens: createEnsClient(config.ensChain, config.ensRpcUrl),
    network: config.network,
    beamPay: config.beamPay,
    wallet,
    dailyLimit,
  };
  await createMcpServer(deps).connect(new StdioServerTransport());
  console.error(`Beam MCP ready (${config.network.name}, wallet ${wallet.slice(0, 4)}…${wallet.slice(-4)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
