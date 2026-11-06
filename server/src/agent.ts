/**
 * @file The Claude tool loop and the no-AI fallback behind `POST /v1/agent`.
 *
 * Intents only ever come from `prepare_payment` (agent path) or from
 * the shared `prepareTransfer` on a fallback-parser candidate. Model text is
 * never parsed into an intent.
 */
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { Address } from 'viem';
import type { ChainClient } from './chain';
import type { EnsReader } from './ens';
import { parseFallback } from './fallbackParser';
import { scanInjection } from './injection';
import { isTransferError, prepareTransfer, shortAddress, type Intent } from './intent';
import type { Network } from './network';
import { buildMessages, buildSystemPrompt } from './prompt';
import { screenAssessment } from './risk';
import type { AgentRequest, AgentResponse, Clarification } from './schemas';
import { runTool, toolDefs } from './tools/index';
import { errorCode, INJECTION_BLOCKED_MESSAGE, paymentBlock, resolverFor, type ToolCtx } from './tools/tool';

const MAX_ITERATIONS = 4;
const CALL_TIMEOUT_MS = 15_000;
const DEADLINE_MS = 25_000;
// Replies are short, but adaptive thinking on current Haiku counts toward max_tokens, so leave headroom.
const MAX_TOKENS = 1024;
const MAX_REPLY_CHARS = 240;

/** One Messages API call. Production wraps `client.messages.create`; tests pass a stub. */
export type CreateMessage = (
  body: Anthropic.MessageCreateParamsNonStreaming,
  options: { timeout: number; signal: AbortSignal },
) => Promise<Anthropic.Message>;

/** What `runAgent` needs from the outside world. */
export type AgentDeps = {
  /** Null when no API key is configured: every request uses the fallback parser. */
  createMessage: CreateMessage | null;
  chain: ChainClient;
  /** ENS client; null disables name payments (`NAME_UNAVAILABLE`). */
  ens: EnsReader | null;
  network: Network;
  /** BeamPay deployment on `network`. */
  beamPay: Address;
  model: string;
  /** Overall request deadline; defaults to 25 s. */
  deadlineMs?: number;
};

/** The response plus error codes for the request log line. */
type AgentOutcome = { response: AgentResponse; errorCodes: string[] };

type Answer = { reply: string; intents: Intent[]; clarification: Clarification | null; fallback: boolean };

/**
 * Wraps the Anthropic SDK client as a `CreateMessage`.
 * @param client Configured SDK client.
 * @returns A function performing one non-streaming `messages.create`.
 */
export function anthropicCreateMessage(client: Anthropic): CreateMessage {
  return (body, options) => client.messages.create(body, options);
}

/**
 * Trims model text to at most two sentences and a hard character cap.
 * Splits only on punctuation followed by whitespace, so "0.2 USDC" stays intact.
 * @param text Raw reply.
 * @returns Clamped reply.
 */
export function clampReply(text: string): string {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  const out = sentences.slice(0, 2).join(' ');
  return out.length > MAX_REPLY_CHARS ? `${out.slice(0, MAX_REPLY_CHARS - 1)}…` : out;
}

/**
 * Handles one agent request: tool loop when a model is available, fallback parser otherwise
 * or when the model fails or the deadline passes. Never throws for model or RPC failures.
 * @param req Validated request.
 * @param deps Model and chain access.
 * @returns Response and error codes for logging.
 */
export async function runAgent(req: AgentRequest, deps: AgentDeps): Promise<AgentOutcome> {
  const started = Date.now();
  const ctx: ToolCtx = {
    action: req.action,
    chain: deps.chain,
    ens: deps.ens,
    network: deps.network,
    beamPay: deps.beamPay,
    wallet: req.wallet.address,
    dailyRemaining: req.limits.dailyRemaining,
    origin: 'phone',
    context: req.context,
    userTexts: req.messages.filter((m) => m.role === 'user').map((m) => m.text),
    intents: [],
    clarification: null,
    assessment: null,
  };
  const toolCalls: string[] = [];
  const errorCodes: string[] = [];

  // Scan before any model call. A suspicious capture never enters the model or fallback payment paths.
  const suspicious = scanInjection(req.context?.text ?? '').suspected;
  if (suspicious) errorCodes.push('PROMPT_INJECTION_BLOCKED');
  const answer: Answer = suspicious
    ? { reply: INJECTION_BLOCKED_MESSAGE, intents: [], clarification: null, fallback: false }
    : await answerWithModel(req, deps, ctx, toolCalls, errorCodes).catch(async (e: unknown) => {
    errorCodes.push(llmErrorCode(e));
    // Snapshot first: a loop abandoned at the deadline may still be running in the background.
    const intents = [...ctx.intents];
    if (intents.length) return { reply: readyReply(intents), intents, clarification: null, fallback: false };
    return runFallback(req, ctx, errorCodes);
  });

  // Injection and financial scam signals are separate. Never label a blocked capture "safe".
  const assessment = suspicious ? null : screenAssessment({
    contextText: ctx.context?.text ?? null,
    lastUserText: ctx.userTexts[ctx.userTexts.length - 1] ?? '',
    reported: ctx.assessment,
    hasIntents: answer.intents.length > 0,
  });

  return {
    response: {
      requestId: req.requestId,
      reply: clampReply(answer.reply),
      intents: answer.intents,
      clarification: answer.clarification,
      assessment,
      meta: { model: deps.model, toolCalls, ms: Date.now() - started, fallback: answer.fallback },
    },
    errorCodes,
  };
}

/** Runs the tool loop under the overall deadline; rejects on model failure or timeout. */
async function answerWithModel(
  req: AgentRequest,
  deps: AgentDeps,
  ctx: ToolCtx,
  toolCalls: string[],
  errorCodes: string[],
): Promise<Answer> {
  const createMessage = deps.createMessage;
  if (!createMessage) throw new Error('NO_API_KEY');
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('DEADLINE')), deps.deadlineMs ?? DEADLINE_MS);
  const expired = new Promise<never>((_, reject) => {
    deadline.signal.addEventListener('abort', () => reject(deadline.signal.reason));
  });
  try {
    const text = await Promise.race([toolLoop(req, createMessage, deps.model, ctx, toolCalls, errorCodes, deadline.signal), expired]);
    const reply = ctx.clarification?.question ?? (text || readyReply(ctx.intents));
    return { reply, intents: ctx.intents, clarification: ctx.clarification, fallback: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls the model up to `MAX_ITERATIONS` times, running requested tools between calls.
 * Stops on a non-tool turn or after `ask_user`.
 * @returns The last assistant text, if any.
 */
async function toolLoop(
  req: AgentRequest,
  createMessage: CreateMessage,
  model: string,
  ctx: ToolCtx,
  toolCalls: string[],
  errorCodes: string[],
  signal: AbortSignal,
): Promise<string> {
  const messages = buildMessages(req);
  const system = buildSystemPrompt(ctx.network, ctx.action);
  const tools = toolDefs(ctx.network, paymentBlock(ctx) === null);
  let lastText = '';
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await createMessage(
      {
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools,
        messages,
        // Overlay UX is latency-bound; extraction does not need deep thinking.
        output_config: { effort: 'low' },
      },
      { timeout: CALL_TIMEOUT_MS, signal },
    );
    messages.push({ role: 'assistant', content: res.content });
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ').trim();
    if (text) lastText = text;
    if (res.stop_reason !== 'tool_use') break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      signal.throwIfAborted();
      toolCalls.push(block.name.slice(0, 40));
      const out = await runTool(block.name, block.input, ctx);
      const code = errorCode(out);
      if (code) errorCodes.push(code);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out), is_error: !!code });
    }
    messages.push({ role: 'user', content: results });
    if (ctx.clarification) break;
  }
  return lastText;
}

/** No-AI path: regex parse, then the same validation as `prepare_payment`. */
async function runFallback(req: AgentRequest, ctx: ToolCtx, errorCodes: string[]): Promise<Answer> {
  const blocked = paymentBlock(ctx);
  if (blocked) {
    errorCodes.push(errorCode(blocked)!);
    return {
      reply: ctx.action === 'inspect' ? 'The agent is unavailable. No payment was prepared. Choose Pay when you want to make a payment.' : String(blocked.message),
      intents: [], clarification: null, fallback: true,
    };
  }
  const parsed = parseFallback({ contextText: req.context?.text ?? null, userTexts: ctx.userTexts, network: ctx.network });
  if (parsed.kind === 'clarify') {
    const clarification = { question: parsed.question, options: parsed.options };
    return { reply: parsed.question, intents: [], clarification, fallback: true };
  }
  const result = await prepareTransfer(
    { chain: ctx.chain, resolveName: resolverFor(ctx) },
    {
      id: randomUUID(),
      to: parsed.to,
      amount: parsed.amount,
      wallet: ctx.wallet,
      dailyRemaining: ctx.dailyRemaining,
      context: ctx.context,
      userTexts: ctx.userTexts,
      parsedBy: 'fallback',
      origin: ctx.origin,
      network: ctx.network,
      beamPay: ctx.beamPay,
    },
  );
  if (isTransferError(result)) {
    errorCodes.push(result.error);
    return { reply: result.message, intents: [], clarification: null, fallback: true };
  }
  const reply = `Using the basic parser: ${result.amountDisplay} to ${result.toName ?? shortAddress(result.to)} is ready to review.`;
  return { reply, intents: [result], clarification: null, fallback: true };
}

/** Default reply when the model produced no text, e.g. the loop ran out of iterations. */
function readyReply(intents: Intent[]): string {
  if (intents.length === 0) return 'Try rephrasing.';
  return intents.length === 1 ? 'Payment ready to review.' : `${intents.length} payments ready to review.`;
}

/** Log-safe code for a model-path failure. */
function llmErrorCode(e: unknown): string {
  if (e instanceof Error && (e.message === 'DEADLINE' || e.message === 'NO_API_KEY')) return e.message;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'LLM_TIMEOUT';
  if (e instanceof Anthropic.APIError) return `LLM_${e.status ?? 'NETWORK'}`;
  return 'LLM_ERROR';
}
