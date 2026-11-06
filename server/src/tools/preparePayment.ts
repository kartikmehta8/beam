/**
 * @file `prepare_payment`: the only way an intent is created. A thin wrapper
 * over the shared `prepareTransfer` (name-aware, sets `approvalReasons` and
 * `route`) plus the per-request intent limit.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isTransferError, MAX_INTENTS_PER_REQUEST, prepareTransfer, shortAddress, type Intent } from '../intent';
import { defineTool, paymentBlock, resolverFor, toolError, type ToolCtx, type ToolOutput } from './tool';

/** Tool input; MCP extends it with `context`. */
const input = z.object({
  to: z.string().max(255).describe('Recipient: a 0x address or an ENS name (like rahul.eth), copied exactly.'),
  amount: z.string().max(40).describe('Amount as a decimal string, e.g. "12" or "0.5".'),
  reason: z.string().max(200).describe('Short note on why, e.g. "dinner split".'),
});

/**
 * One-line summary of an intent for the model.
 * @param intent Prepared intent.
 * @returns e.g. "Send 12 USDC to rahul.eth (0xAbC1…F123), fee about 0.0021 USDC."
 */
function summarize(intent: Intent): string {
  const who = intent.toName ? `${intent.toName} (${shortAddress(intent.to)})` : shortAddress(intent.to);
  const approval = intent.route === 'payWithApproval' ? ' Needs World ID approval.' : '';
  return `Send ${intent.amountDisplay} to ${who}, fee about ${intent.estFeeDisplay}.${approval} Ready for the user to review.`;
}

/**
 * Runs shared validation and records the intent on success.
 * @param ctx Tool context (origin decides `EXTERNAL_AGENT`).
 * @param args Parsed tool input.
 * @returns Tool output: `{ ok, intentId, summary, route, approvalReasons, warnings }` or a `{ error, message }`.
 */
export async function runPreparePayment(ctx: ToolCtx, args: z.infer<typeof input>): Promise<ToolOutput> {
  const blocked = paymentBlock(ctx);
  if (blocked) return blocked;
  if (ctx.intents.length >= MAX_INTENTS_PER_REQUEST) {
    return toolError('TOO_MANY_INTENTS', `At most ${MAX_INTENTS_PER_REQUEST} payments per request.`);
  }
  const result = await prepareTransfer(
    { chain: ctx.chain, resolveName: resolverFor(ctx) },
    {
      id: randomUUID(),
      to: args.to,
      amount: args.amount,
      wallet: ctx.wallet,
      dailyRemaining: ctx.dailyRemaining,
      context: ctx.context,
      userTexts: ctx.userTexts,
      parsedBy: 'agent',
      origin: ctx.origin,
      network: ctx.network,
      beamPay: ctx.beamPay,
    },
  );
  if (isTransferError(result)) return { ...result };
  ctx.intents.push(result);
  return {
    ok: true,
    intentId: result.id,
    summary: summarize(result),
    route: result.route,
    approvalReasons: result.approvalReasons,
    warnings: result.warnings,
  };
}

export const preparePayment = defineTool({
  name: 'prepare_payment',
  description: (n) =>
    `Prepares (does not send) a ${n.symbol} payment on ${n.name} for the user to review and confirm on their phone. ` +
    'Only call when the user asks to pay. The recipient (0x address or ENS name) must appear on screen or in the user message.',
  input,
  run: runPreparePayment,
});
