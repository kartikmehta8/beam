/**
 * @file Types and helpers shared by every agent tool. Kept apart from
 * `tools/index.ts` so tool modules don't import the registry that imports them.
 */
import type { Address } from 'viem';
import type { z } from 'zod';
import type { ChainClient } from '../chain';
import { createNameResolver, type EnsReader, type NameResolver } from '../ens';
import type { Intent, IntentOrigin, ScreenContextInput, TransferErrorCode } from '../intent';
import type { Network } from '../network';
import type { Assessment } from '../risk';
import type { Clarification } from '../schemas';
import { scanInjection } from '../injection';

/** Per-request state the tools read and write. The model can only reach it through tool inputs. */
export type ToolCtx = {
  /** Current app-selected capability; prior messages cannot authorize another payment. */
  action: 'inspect' | 'pay';
  chain: ChainClient;
  /** ENS client (mainnet or Sepolia); null when ENS lookups are disabled. */
  ens: EnsReader | null;
  network: Network;
  /** BeamPay deployment on `network`. */
  beamPay: Address;
  /** The user's own wallet (checksummed); the model cannot substitute another. */
  wallet: Address;
  /** Decimal string in the network's token. */
  dailyRemaining: string;
  /** "phone" for /v1/agent, "mcp" for the MCP server (adds EXTERNAL_AGENT). */
  origin: IntentOrigin;
  context: ScreenContextInput | null;
  /** All user-authored messages, used for provenance. */
  userTexts: string[];
  /** Intents created so far; only `prepare_payment` appends. */
  intents: Intent[];
  /** Set by `ask_user`; ends the loop. */
  clarification: Clarification | null;
  /** Set by `assess_screen`, already merged with the deterministic floor. */
  assessment: Assessment | null;
};

/** Error codes a tool can return: transfer validation codes plus dispatcher codes. */
type ToolErrorCode = TransferErrorCode | 'BAD_TOOL_INPUT' | 'TOO_MANY_INTENTS' | 'PAYMENT_NOT_AUTHORIZED' | 'PROMPT_INJECTION_BLOCKED';
/** JSON object returned to the model. Errors carry `{ error, message }`. */
export type ToolOutput = Record<string, unknown>;

/** A tool: a zod input schema plus an implementation that receives parsed input. */
export type Tool<S extends z.ZodObject> = {
  name: string;
  /** Description sent to the model, filled in for the server's network. */
  description: (network: Network) => string;
  input: S;
  run: (ctx: ToolCtx, input: z.infer<S>) => Promise<ToolOutput>;
};

/**
 * Identity helper so each tool file gets its input type inferred from its schema.
 * @param tool Tool definition.
 * @returns The same tool.
 */
export const defineTool = <S extends z.ZodObject>(tool: Tool<S>): Tool<S> => tool;

/**
 * Builds a tool error result.
 * @param error Machine-readable code.
 * @param message One plain sentence the model can relay.
 * @returns `{ error, message }`.
 */
export const toolError = (error: ToolErrorCode, message: string): ToolOutput => ({ error, message });

export const INJECTION_BLOCKED_MESSAGE = 'The captured text contains instructions aimed at the assistant. Payments from this capture are blocked.';

/** A deterministic gate, also used by direct tool and MCP callers. */
export function paymentBlock(ctx: ToolCtx): ToolOutput | null {
  if (ctx.action !== 'pay') return toolError('PAYMENT_NOT_AUTHORIZED', 'This turn is for inspection. Choose Pay to prepare a payment.');
  if (scanInjection(ctx.context?.text ?? '').suspected) return toolError('PROMPT_INJECTION_BLOCKED', INJECTION_BLOCKED_MESSAGE);
  return null;
}

/**
 * Whether a tool output is an error.
 * @param out Tool output.
 * @returns The error code, or null on success.
 */
export const errorCode = (out: ToolOutput): string | null => (typeof out.error === 'string' ? out.error : null);

/**
 * The name resolver for this request's network, or null when ENS is disabled.
 * @param ctx Tool context.
 * @returns A shared-code `NameResolver`.
 */
export const resolverFor = (ctx: ToolCtx): NameResolver | null =>
  ctx.ens ? createNameResolver(ctx.ens, ctx.network.chainId) : null;
