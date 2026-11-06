/**
 * @file Agent client: `POST /v1/agent` and turn planning.
 *
 * The server response is untrusted. Only `{id, to, toName, amountWei}` is
 * taken from each proposed intent; the full intent (provenance, name
 * resolution, cap, gas, fee, warnings, approval reasons) is rebuilt on the
 * device with the same `prepareTransfer` the server uses, so a compromised
 * server cannot inject a recipient, fee or gas limit. When both sides resolve
 * a name, their addresses must match.
 *
 * Network errors, timeouts, 429 and 5xx fall back to the offline regex parser,
 * and so does a server on a different network. 401 does not.
 */
import { randomUUID } from 'expo-crypto';
import { formatUnits, type Address } from 'viem';
import { config, NETWORK } from './config';
import { parseFallback } from './fallbackParser';
import {
  isTransferError,
  MAX_INTENTS_PER_REQUEST,
  toChecksumAddress,
  type ContextSource,
  type Intent,
  type ScreenContextInput,
  type TransferError,
} from './intent';
import type { LimitState } from './limits';
import { RISK_LEVELS, RISK_SIGNALS, screenAssessment, type Assessment } from './risk';
import { scanInjection } from './injection';
import { prepareOnDevice, toDecimal } from './prepare';
import { loadServerStatus } from './serverApi';
import { isRecord, isStringArray, isWeiString } from './storage';

/** Request timeout. */
const AGENT_TIMEOUT_MS = 30_000;
/** Most chat turns sent per request. */
const MAX_HISTORY = 10;

export type ChatTurn = { role: 'user' | 'assistant'; text: string };

/** Screen or clipboard text as sent to the agent. */
export type AgentContext = {
  source: ContextSource;
  appLabel: string;
  packageName?: string;
  text: string;
  capturedAt: number;
};

type AgentRequest = {
  requestId: string;
  action: 'inspect' | 'pay';
  messages: ChatTurn[];
  context: AgentContext | null;
  wallet: { address: Address; chainId: number };
  limits: { dailyRemaining: string };
};

export type Clarification = { question: string; options: string[] };

/** The only intent fields the app reads from the server. */
type ProposedIntent = Pick<Intent, 'id' | 'to' | 'toName' | 'amountWei'>;

type AgentResponse = { reply: string; intents: ProposedIntent[]; clarification: Clarification | null; assessment: Assessment | null };

/** Why the agent couldn't be used for a turn. */
export type AgentErrorKind = 'offline' | 'auth' | 'bad-response' | 'mismatch';

/** Typed agent failure. `kind` decides fallback vs. error. */
class AgentError extends Error {
  /**
   * @param kind Failure class.
   * @param message Developer detail (never shown verbatim, never contains user text).
   */
  constructor(
    readonly kind: AgentErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

const isProposal = (v: unknown): v is ProposedIntent =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  v.id.length > 0 &&
  typeof v.to === 'string' &&
  (v.toName === undefined || typeof v.toName === 'string') &&
  isWeiString(v.amountWei);

const isClarification = (v: unknown): v is Clarification =>
  isRecord(v) && typeof v.question === 'string' && isStringArray(v.options);

const isAssessment = (v: unknown): v is Assessment =>
  isRecord(v) &&
  (RISK_LEVELS as readonly string[]).includes(v.level as string) &&
  Array.isArray(v.signals) &&
  v.signals.every((s) => (RISK_SIGNALS as readonly string[]).includes(s as string));

/**
 * Validates the response body (only the fields the app uses).
 * @param v Parsed JSON.
 * @param requestId The ID we sent; the server must echo it.
 * @returns The response, or null when the shape is wrong.
 */
function parseResponse(v: unknown, requestId: string): AgentResponse | null {
  if (!isRecord(v) || v.requestId !== requestId || typeof v.reply !== 'string') return null;
  if (!Array.isArray(v.intents) || !v.intents.every(isProposal)) return null;
  const clarification = v.clarification ?? null;
  if (clarification !== null && !isClarification(clarification)) return null;
  const assessment = isAssessment(v.assessment) ? v.assessment : null;
  return {
    reply: v.reply,
    intents: v.intents.slice(0, MAX_INTENTS_PER_REQUEST),
    clarification: clarification && { question: clarification.question, options: clarification.options.slice(0, 4) },
    assessment,
  };
}

/**
 * Calls the agent server.
 * @param req Request body.
 * @param signal Caller's abort signal (sheet dismissed). Aborting rethrows the abort error as-is.
 * @returns The validated response.
 * @throws AgentError `offline` (network, timeout, 429, 5xx, unconfigured), `auth` (401), `bad-response`.
 */
async function askAgent(req: AgentRequest, signal: AbortSignal): Promise<AgentResponse> {
  if (!config.agentUrl) throw new AgentError('offline', 'EXPO_PUBLIC_AGENT_URL is not set');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort);
  const timer = setTimeout(onAbort, AGENT_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${config.agentUrl}/v1/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.agentToken}` },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new AgentError('offline', 'Network error or timeout');
    }
    if (res.status === 401) throw new AgentError('auth', 'HTTP 401');
    if (res.status === 429 || res.status >= 500) throw new AgentError('offline', `HTTP ${res.status}`);
    if (!res.ok) throw new AgentError('bad-response', `HTTP ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      if (signal.aborted) throw e;
      throw new AgentError(controller.signal.aborted ? 'offline' : 'bad-response', 'Body read failed');
    }
    const parsed = parseResponse(body, req.requestId);
    if (!parsed) throw new AgentError('bad-response', 'Unexpected response shape');
    return parsed;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** What one user message produced. */
type TurnOutcome = {
  /** Shown as a system line above the reply when the agent couldn't be used. */
  notice: { kind: AgentErrorKind; text: string; tone: 'warning' | 'danger' } | null;
  reply: string;
  intents: Intent[];
  clarification: Clarification | null;
  assessment: Assessment | null;
};

type TurnInput = {
  /** Explicit UI action for this turn. Omitted/unknown values grant no payment permission. */
  action?: 'inspect' | 'pay';
  /** Conversation so far, oldest first, ending with the new user message. */
  history: ChatTurn[];
  /** Context to share, or null when unavailable or excluded. */
  context: AgentContext | null;
  wallet: Address;
  limits: LimitState;
  signal: AbortSignal;
};

/** System line for each reason the basic parser takes over. */
const FALLBACK_NOTICE: Record<Exclude<AgentErrorKind, 'auth'>, { text: string; tone: 'warning' | 'danger' }> = {
  mismatch: { text: 'Server is on a different network. Using basic parser.', tone: 'danger' },
  offline: { text: 'Agent offline. Using basic parser.', tone: 'warning' },
  'bad-response': { text: 'Agent sent a bad response. Using basic parser.', tone: 'warning' },
};

/** Shown when the device and the server resolve a name to different addresses. */
const NAME_MISMATCH: TransferError = { error: 'NAME_NOT_FOUND', message: 'Name resolution mismatch. Try again.' };

/**
 * Plans one turn: asks the agent, rebuilds its intents locally, or falls back
 * to the regex parser when the agent is unreachable or on another network.
 * @param input History, context, wallet, limits and abort signal.
 * @returns Reply, locally validated intents and an optional clarification.
 * @throws The abort error when `input.signal` fires.
 */
export async function planTurn(input: TurnInput): Promise<TurnOutcome> {
  const { history, context, wallet, limits, signal } = input;
  const action = input.action === 'pay' ? 'pay' : 'inspect';
  const assertActive = () => { if (signal.aborted) throw new Error('Request cancelled'); };
  assertActive();
  const assessmentFor = (reported: Assessment | null, hasIntents: boolean) => screenAssessment({
    contextText: context?.text ?? null,
    lastUserText: history.filter((t) => t.role === 'user').at(-1)?.text ?? '',
    reported,
    hasIntents,
  });
  if (context && scanInjection(context.text).suspected) {
    return {
      notice: null,
      reply: 'This screen contains instructions that may be trying to manipulate Beam. Payment from this screen has been blocked. You can enter payment details manually.',
      intents: [], clarification: null, assessment: null,
    };
  }
  const userTexts = history.filter((t) => t.role === 'user').map((t) => t.text);
  const contextInput: ScreenContextInput | null = context && {
    source: context.source,
    appLabel: context.appLabel,
    text: context.text,
  };
  const prepare = (id: string, to: string, amount: string, parsedBy: Intent['parsedBy']) =>
    prepareOnDevice({
      id,
      to,
      amount,
      wallet,
      remainingWei: limits.remainingWei,
      context: contextInput,
      userTexts,
      parsedBy,
      origin: 'phone',
    });

  let failure: AgentErrorKind;
  try {
    if ((await loadServerStatus()).kind === 'mismatch') throw new AgentError('mismatch', 'Server network differs');
    assertActive();
    const res = await askAgent(
      {
        requestId: randomUUID(),
        action,
        messages: history.slice(-MAX_HISTORY),
        context,
        wallet: { address: wallet, chainId: NETWORK.chainId },
        limits: { dailyRemaining: toDecimal(limits.remainingWei) },
      },
      signal,
    );
    assertActive();
    // The phone enforces its own UI permission even against an older or compromised server.
    if (action !== 'pay' && res.intents.length) {
      return {
        notice: null, reply: 'This was an inspection request. No payment was prepared. Choose Prepare payment if you want to pay.',
        intents: [], clarification: null, assessment: assessmentFor(res.assessment, false),
      };
    }
    const results = await Promise.all(
      res.intents.map(async (p): Promise<Intent | TransferError> => {
        const local = await prepare(p.id, p.toName ?? p.to, formatUnits(BigInt(p.amountWei), 18), 'agent');
        if (isTransferError(local) || !p.toName) return local;
        return toChecksumAddress(p.to) === local.to ? local : NAME_MISMATCH;
      }),
    );
    assertActive();
    const errors = [...new Set(results.filter(isTransferError).map((r) => r.message))];
    return {
      notice: null,
      reply: [res.reply, ...errors].filter(Boolean).join('\n\n'),
      intents: results.filter((r): r is Intent => !isTransferError(r)),
      clarification: res.clarification,
      assessment: assessmentFor(res.assessment, results.some((r) => !isTransferError(r))),
    };
  } catch (e) {
    if (signal.aborted || !(e instanceof AgentError)) throw e;
    failure = e.kind;
  }

  if (failure === 'auth') {
    return { notice: { kind: failure, text: 'Agent auth failed (check token)', tone: 'danger' }, reply: '', intents: [], clarification: null, assessment: null };
  }
  const notice: TurnOutcome['notice'] = { kind: failure, ...FALLBACK_NOTICE[failure] };
  assertActive();
  if (action !== 'pay') {
    return { notice, reply: 'The agent is unavailable. No payment was prepared. Choose Prepare payment to use the basic payment parser.', intents: [], clarification: null, assessment: assessmentFor(null, false) };
  }
  const parsed = parseFallback({ contextText: context?.text ?? null, userTexts, network: NETWORK });
  if (parsed.kind === 'clarify') {
    return { notice, reply: '', intents: [], clarification: { question: parsed.question, options: parsed.options }, assessment: assessmentFor(null, false) };
  }
  const result = await prepare(randomUUID(), parsed.to, parsed.amount, 'fallback');
  assertActive();
  return isTransferError(result)
    ? { notice, reply: result.message, intents: [], clarification: null, assessment: assessmentFor(null, false) }
    : { notice, reply: '', intents: [result], clarification: null, assessment: assessmentFor(null, true) };
}
