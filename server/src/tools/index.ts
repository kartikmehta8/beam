/**
 * @file Agent tool registry: Anthropic tool definitions
 * generated from each tool's zod input schema, and the `runTool` dispatcher.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Network } from '../network';
import { askUser } from './askUser';
import { assessScreen } from './assessScreen';
import { getTxStatus } from './getTxStatus';
import { getWalletBalance } from './getWalletBalance';
import { getScreenContext } from './getScreenContext';
import { inspectRecipient } from './inspectRecipient';
import { preparePayment } from './preparePayment';
import { paymentBlock, toolError, type Tool, type ToolCtx, type ToolOutput } from './tool';

type Caller = (ctx: ToolCtx, raw: unknown) => Promise<ToolOutput>;

/**
 * Wraps a tool for the dispatcher: validates raw model input and converts any
 * thrown error (RPC failure after retries) into an `RPC_ERROR` result.
 * @param tool Tool definition.
 * @returns A never-throwing caller.
 */
export function safeCaller<S extends z.ZodObject>(tool: Tool<S>): Caller {
  return async (ctx, raw) => {
    const parsed = tool.input.safeParse(raw);
    if (!parsed.success) return toolError('BAD_TOOL_INPUT', z.prettifyError(parsed.error).slice(0, 300));
    try {
      return await tool.run(ctx, parsed.data);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
      return toolError('RPC_ERROR', `Couldn't reach ${ctx.network.name}: ${msg.slice(0, 120)}`);
    }
  };
}

/**
 * Anthropic definition of a tool for a network.
 * @param tool Tool definition.
 * @param network Network whose names fill the description.
 * @returns Messages API tool.
 */
function toDef<S extends z.ZodObject>(tool: Tool<S>, network: Network): Anthropic.Tool {
  const schema = z.toJSONSchema(tool.input);
  return {
    name: tool.name,
    description: tool.description(network),
    input_schema: { type: 'object', properties: schema.properties ?? {}, required: schema.required ?? [] },
  };
}

const TOOLS = [getWalletBalance, inspectRecipient, preparePayment, getTxStatus, askUser, assessScreen, getScreenContext] as const;
const CALLERS = new Map<string, Caller>(TOOLS.map((t) => [t.name, safeCaller(t as Tool<z.ZodObject>)]));

/**
 * Tool definitions sent to the Messages API.
 * @param network The server's network.
 * @returns One definition per tool.
 */
export function toolDefs(network: Network, allowPayments = false): Anthropic.Tool[] {
  return TOOLS.filter((t) => allowPayments || t.name !== 'prepare_payment').map((t) => toDef(t as Tool<z.ZodObject>, network));
}

/**
 * Runs a tool requested by the model. Never throws.
 * @param name Tool name from the `tool_use` block.
 * @param input Raw, untrusted tool input.
 * @param ctx Per-request tool state.
 * @returns Tool output; unknown tools and invalid input give `BAD_TOOL_INPUT`.
 */
export async function runTool(name: string, input: unknown, ctx: ToolCtx): Promise<ToolOutput> {
  if (name === 'prepare_payment') {
    const blocked = paymentBlock(ctx);
    if (blocked) return blocked;
  }
  const call = CALLERS.get(name);
  return call ? call(ctx, input) : toolError('BAD_TOOL_INPUT', `Unknown tool "${name.slice(0, 40)}".`);
}
