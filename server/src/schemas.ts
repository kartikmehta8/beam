/**
 * @file Boundary schemas for the `POST /v1/agent` request and response.
 * Everything that enters the server is parsed here first. Schemas are built
 * per network so the wallet's chain ID and amount precision are checked exactly.
 */
import { z } from 'zod';
import { parseAmount, toChecksumAddress, type Intent } from './intent';
import type { Network } from './network';
import { RISK_LEVELS, RISK_SIGNALS } from './risk';

/** Max characters of captured screen/clipboard text (the app truncates at 4000). */
const MAX_CONTEXT_CHARS = 4000;
/** Max characters per chat message. */
const MAX_MESSAGE_CHARS = 2000;
/** Max chat turns per request. */
const MAX_MESSAGES = 10;

/** A checksummed 0x address; all-lowercase input is accepted and checksummed. */
export const WalletAddress = z.string().transform((value, ctx) => {
  const address = toChecksumAddress(value);
  if (!address) {
    ctx.addIssue({ code: 'custom', message: 'invalid address' });
    return z.NEVER;
  }
  return address;
});

/**
 * A decimal amount in the network's token, at most `amountDecimals` fractional digits.
 * @param network Target network.
 * @returns String schema.
 */
export const amountString = (network: Network) =>
  z
    .string()
    .max(40)
    .refine((v) => parseAmount(v, network) !== null, `must be a ${network.symbol} decimal string like "1" or "0.5"`);

/**
 * Request body schema for a network.
 * @param network The server's network; `wallet.chainId` must equal its chain ID.
 * @returns Zod schema.
 */
export function agentRequestSchema(network: Network) {
  return z.object({
    requestId: z.string().min(1).max(100),
    // Capability for this turn, selected by the app; never inferred from screen text or history.
    action: z.enum(['inspect', 'pay']).default('inspect'),
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(MAX_MESSAGE_CHARS) }))
      .min(1)
      .max(MAX_MESSAGES)
      .refine((m) => m[m.length - 1]?.role === 'user', 'last message must be from the user'),
    context: z
      .object({
        source: z.enum(['screen', 'clipboard']),
        appLabel: z.string().max(100),
        packageName: z.string().max(200).optional(),
        text: z.string().max(MAX_CONTEXT_CHARS),
        capturedAt: z.number(),
      })
      .nullable(),
    wallet: z.object({ address: WalletAddress, chainId: z.literal(network.chainId) }),
    limits: z.object({ dailyRemaining: amountString(network) }),
  });
}

/** Parsed request body. */
export type AgentRequest = z.infer<ReturnType<typeof agentRequestSchema>>;

const Hex = z.templateLiteral(['0x', z.string()]);

/**
 * Intent schema for a network. Mirrors the shared `Intent`; the annotation fails to compile if they drift.
 * @param network Target network.
 * @returns Zod schema.
 */
function intentSchema(network: Network): z.ZodType<Intent> {
  return z.object({
    id: z.string(),
    type: z.literal('payment'),
    network: z.literal(network.key),
    chainId: z.literal(network.chainId),
    to: Hex,
    toName: z.string().optional(),
    amountWei: z.string(),
    amountDisplay: z.string(),
    gasLimit: z.string(),
    maxFeePerGasWei: z.string(),
    estFeeDisplay: z.string(),
    intentHash: Hex,
    route: z.enum(['pay', 'payWithApproval']),
    approvalReasons: z.array(z.enum(['OVER_CAP', 'NEW_RECIPIENT', 'NAME_CHANGED', 'EXTERNAL_AGENT'])),
    provenance: z.object({ source: z.enum(['screen', 'clipboard', 'user', 'both']), appLabel: z.string().optional() }),
    recipientIsContract: z.boolean(),
    warnings: z.array(
      z.enum([
        'NEW_RECIPIENT',
        'RECIPIENT_IS_CONTRACT',
        'SELF_TRANSFER',
        'AMOUNT_NOT_IN_CONTEXT',
        'PARSED_WITHOUT_AI',
        'CLOSE_TO_DAILY_LIMIT',
        'NAME_NOT_PRIMARY',
        'NAME_ADDRESS_CHANGED',
      ]),
    ),
    createdAt: z.number(),
    expiresAt: z.number(),
    parsedBy: z.enum(['agent', 'fallback', 'manual']),
    origin: z.enum(['phone', 'mcp']),
  });
}

const ClarificationSchema = z.object({ question: z.string(), options: z.array(z.string()) });
/** A question with tappable options. */
export type Clarification = z.infer<typeof ClarificationSchema>;

/** Scam Shield verdict on the captured screen. */
const AssessmentSchema = z.object({ level: z.enum(RISK_LEVELS), signals: z.array(z.enum(RISK_SIGNALS)) });

/**
 * Response body schema for a network (used by tests and as the contract for the app).
 * @param network Target network.
 * @returns Zod schema.
 */
export function agentResponseSchema(network: Network) {
  return z.object({
    requestId: z.string(),
    reply: z.string(),
    intents: z.array(intentSchema(network)),
    clarification: ClarificationSchema.nullable(),
    assessment: AssessmentSchema.nullable(),
    meta: z.object({ model: z.string(), toolCalls: z.array(z.string()), ms: z.number(), fallback: z.boolean() }),
  });
}

/** Response body returned to the app. */
export type AgentResponse = z.infer<ReturnType<typeof agentResponseSchema>>;
