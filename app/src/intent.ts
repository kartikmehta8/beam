/**
 * @file Intent model and payment preparation for Beam.
 *
 * SHARED FILE: byte-identical copies live at `app/src/intent.ts` and
 * `server/src/intent.ts`. Edit one, copy it to the other;
 * `server/test/shared.test.ts` fails if they drift.
 *
 * The only way an `Intent` is created is `prepareTransfer`, which enforces
 * recipient validity (0x address or ENS name), provenance (the recipient must
 * appear in the screen context or a user message), amount format, the daily
 * limit and balance, and decides whether World ID approval is required.
 */
import { formatUnits, getAddress, parseUnits, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { extractEnsNames, normalizeEnsName, type NameResolver } from './ens';
import type { Network, NetworkKey } from './network';
import { computeIntentHash, BEAM_PAY_ABI } from './beamPay';

/** Intents expire five minutes after creation. */
const INTENT_TTL_MS = 5 * 60_000;
/** Gas BeamPay adds over a plain value transfer: signature check, nonce write, event. */
const BEAM_PAY_OVERHEAD_GAS = 80_000n;
/** Max intents the agent may create per request. */
export const MAX_INTENTS_PER_REQUEST = 3;

/** Where captured context text came from. */
export type ContextSource = 'screen' | 'clipboard';
/** Where the recipient was found: context, a user message, or both. */
export type ProvenanceSource = ContextSource | 'user' | 'both';
/** Who asked for the payment: the user on the phone, or an external agent over MCP. */
export type IntentOrigin = 'phone' | 'mcp';

/** Soft warnings shown on the review card; none of them block the payment. */
export type IntentWarning =
  | 'NEW_RECIPIENT'
  | 'RECIPIENT_IS_CONTRACT'
  | 'SELF_TRANSFER'
  | 'AMOUNT_NOT_IN_CONTEXT'
  | 'PARSED_WITHOUT_AI'
  | 'CLOSE_TO_DAILY_LIMIT'
  | 'NAME_NOT_PRIMARY'
  | 'NAME_ADDRESS_CHANGED';

/** Why a payment needs a fresh World ID approval before it can be sent. */
export type ApprovalReason = 'OVER_CAP' | 'NEW_RECIPIENT' | 'NAME_CHANGED' | 'EXTERNAL_AGENT';

/** A proposed native-token payment through BeamPay. Never signed by the server. */
export type Intent = {
  id: string;
  type: 'payment';
  network: NetworkKey;
  chainId: number;
  /** Checksummed recipient (the resolved address when paid by name). */
  to: Address;
  /** Normalized ENS name when the recipient was a name. */
  toName?: string;
  /** Decimal wei string. */
  amountWei: string;
  /** e.g. "12.5 USDC". */
  amountDisplay: string;
  gasLimit: string;
  maxFeePerGasWei: string;
  /** e.g. "0.0021 USDC". */
  estFeeDisplay: string;
  /** Binds the onchain payment to this intent (see `computeIntentHash`). */
  intentHash: Hex;
  /** `payWithApproval` when any approval reason applies. */
  route: 'pay' | 'payWithApproval';
  approvalReasons: ApprovalReason[];
  provenance: { source: ProvenanceSource; appLabel?: string };
  recipientIsContract: boolean;
  warnings: IntentWarning[];
  createdAt: number;
  expiresAt: number;
  parsedBy: 'agent' | 'fallback' | 'manual';
  origin: IntentOrigin;
};

/** Hard failures from `prepareTransfer`; no intent is created. */
export type TransferErrorCode =
  | 'INVALID_ADDRESS'
  | 'ZERO_ADDRESS'
  | 'ADDRESS_NOT_IN_CONTEXT'
  | 'NAME_NOT_FOUND'
  | 'NAME_UNAVAILABLE'
  | 'INVALID_AMOUNT'
  | 'OVER_DAILY_LIMIT'
  | 'INSUFFICIENT_BALANCE'
  | 'RECIPIENT_REJECTS'
  | 'RPC_ERROR'
  | 'PROMPT_INJECTION_BLOCKED';

/** Error shape returned to the model and shown to the user (`message` is UX copy). */
export type TransferError = { error: TransferErrorCode; message: string };

/** Captured text from another app (screen) or the clipboard. */
export type ScreenContextInput = { source: ContextSource; appLabel: string; text: string };

/** Everything `prepareTransfer` needs. Amounts are decimal strings in the network's token. */
export type TransferRequest = {
  id: string;
  /** 0x address or ENS name, exactly as found. */
  to: string;
  amount: string;
  wallet: Address;
  dailyRemaining: string;
  context: ScreenContextInput | null;
  /** All user-authored messages in the conversation. */
  userTexts: string[];
  parsedBy: Intent['parsedBy'];
  origin: IntentOrigin;
  network: Network;
  /** BeamPay deployment on `network`. */
  beamPay: Address;
  now?: number;
};

/** The read-only chain calls `prepareTransfer` uses. A viem PublicClient satisfies it. */
export type ChainReader = Pick<PublicClient, 'getCode' | 'getBalance' | 'estimateGas' | 'estimateFeesPerGas' | 'readContract'>;

/** I/O `prepareTransfer` depends on; injected so tests mock the chain and ENS. */
export type TransferDeps = {
  chain: ChainReader;
  /** Null when ENS lookups are unavailable; names then fail with `NAME_UNAVAILABLE`. */
  resolveName: NameResolver | null;
};

const ZERO_WIDTH = /[​-‍﻿]/g;

/**
 * Removes zero-width characters that chat apps insert into long tokens.
 * @param text Raw text.
 * @returns Text without U+200B to U+200D and U+FEFF.
 */
export function stripZeroWidth(text: string): string {
  return text.replace(ZERO_WIDTH, '');
}

/**
 * Parses a decimal amount ("12", "0.5") in the network's token to wei.
 * @param value Decimal string; no sign or exponent, at most `network.amountDecimals` fractional digits.
 * @param network Target network.
 * @returns Wei (may be 0n), or null when malformed.
 */
export function parseAmount(value: string, network: Network): bigint | null {
  const v = value.trim();
  return new RegExp(`^\\d+(\\.\\d{1,${network.amountDecimals}})?$`).test(v) ? parseUnits(v, 18) : null;
}

/**
 * Formats wei as a short amount with the token symbol.
 * @param wei Amount in wei.
 * @param network Network whose symbol to use.
 * @param maxDecimals Fractional digits to keep (truncated, trailing zeros dropped). Defaults to the display precision.
 * @returns e.g. "12.5 USDC", "0.0021 USDC", or "<0.01 USDC" for dust.
 */
export function formatAmount(wei: bigint, network: Network, maxDecimals = network.displayDecimals): string {
  const [int, frac = ''] = formatUnits(wei, 18).split('.');
  const cut = frac.slice(0, maxDecimals).replace(/0+$/, '');
  if (wei > 0n && int === '0' && !cut) return `<0.${'0'.repeat(maxDecimals - 1)}1 ${network.symbol}`;
  return `${int}${cut ? `.${cut}` : ''} ${network.symbol}`;
}

/**
 * Validates and checksums an address. All-lowercase and all-uppercase hex are
 * accepted as unchecksummed; mixed case must carry a valid EIP-55 checksum.
 * @param raw Candidate address, may contain zero-width characters.
 * @returns Checksummed address, or null if invalid.
 */
export function toChecksumAddress(raw: string): Address | null {
  const s = stripZeroWidth(raw).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null;
  const body = s.slice(2);
  const checksummed = getAddress(s.toLowerCase());
  const uniformCase = body === body.toLowerCase() || body === body.toUpperCase();
  return uniformCase || checksummed === s ? checksummed : null;
}

/**
 * Shortens an address for chips and labels.
 * @param address Any 0x address.
 * @returns e.g. "0xAbC1…F123".
 */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Finds where a recipient came from.
 * @param appears Whether the recipient appears in a given text.
 * @param context Captured screen or clipboard text, if any.
 * @param userTexts User-authored messages.
 * @returns The provenance source, or null if the recipient appears nowhere.
 */
function findProvenance(
  appears: (text: string) => boolean,
  context: ScreenContextInput | null,
  userTexts: string[],
): ProvenanceSource | null {
  const has = (t: string) => appears(stripZeroWidth(t));
  const inContext = !!context && has(context.text);
  const inUser = userTexts.some(has);
  if (inContext && inUser) return 'both';
  if (inContext) return context.source;
  return inUser ? 'user' : null;
}

/**
 * Whether the amount appears (numerically) anywhere in the given texts.
 * @param wei Amount to look for.
 * @param texts Context and user messages.
 * @param network Network for amount parsing.
 * @returns True if any number in the texts equals the amount.
 */
function amountAppears(wei: bigint, texts: string[], network: Network): boolean {
  return texts.some((t) => (t.match(/\d+(?:\.\d+)?/g) ?? []).some((n) => parseAmount(n, network) === wei));
}

/** Builds a `TransferError`. */
const fail = (error: TransferErrorCode, message: string): TransferError => ({ error, message });

/** A recipient that passed validity and provenance checks. */
type Recipient = { to: Address; toName?: string; primaryName?: string | null; source: ProvenanceSource };

/**
 * Validates the recipient (address or ENS name) and its provenance, resolving names.
 * Provenance is checked before any lookup so unseen names never reach the network.
 * @param req Transfer request.
 * @param resolveName Name resolver, or null when ENS is unavailable.
 * @returns The recipient, or a `TransferError`.
 */
async function resolveRecipient(req: TransferRequest, resolveName: NameResolver | null): Promise<Recipient | TransferError> {
  const address = toChecksumAddress(req.to);
  if (address) {
    if (address === zeroAddress) return fail('ZERO_ADDRESS', 'That is the zero address. Funds sent there are lost.');
    const needle = new RegExp(`${address.toLowerCase()}(?![0-9a-f])`);
    const source = findProvenance((t) => needle.test(t.toLowerCase()), req.context, req.userTexts);
    if (!source) return fail('ADDRESS_NOT_IN_CONTEXT', 'I can only pay recipients that appear on your screen or in your message.');
    return { to: address, source };
  }

  const name = normalizeEnsName(stripZeroWidth(req.to));
  if (!name) return fail('INVALID_ADDRESS', 'That is not a valid 0x address or ENS name.');
  const source = findProvenance((t) => extractEnsNames(t).includes(name), req.context, req.userTexts);
  if (!source) return fail('ADDRESS_NOT_IN_CONTEXT', 'I can only pay recipients that appear on your screen or in your message.');
  if (!resolveName) return fail('NAME_UNAVAILABLE', "Couldn't look up that name. Use the 0x address.");

  let resolved;
  try {
    resolved = await resolveName(name);
  } catch {
    return fail('NAME_UNAVAILABLE', "Couldn't look up that name. Use the 0x address.");
  }
  if (!resolved || resolved.address === zeroAddress) {
    return fail('NAME_NOT_FOUND', `${name} doesn't have an address for ${req.network.name}.`);
  }
  return { to: resolved.address, toName: name, primaryName: resolved.primaryName, source };
}

/**
 * Validates a payment request and builds an `Intent`. Checks run cheapest and
 * strictest first: recipient → provenance → amount → daily limit → chain state → balance.
 * Over-cap amounts are not errors: they route through World ID approval.
 * @param deps Chain reader and ENS resolver.
 * @param req The payment request.
 * @returns The intent, or a `TransferError` whose `message` is user-facing copy.
 */
export async function prepareTransfer(deps: TransferDeps, req: TransferRequest): Promise<Intent | TransferError> {
  const { network } = req;
  const recipient = await resolveRecipient(req, deps.resolveName);
  if ('error' in recipient) return recipient;
  const { to } = recipient;

  const amount = parseAmount(req.amount, network);
  if (amount === null || amount <= 0n) {
    const tooPrecise = /^\d+\.\d+$/.test(req.amount.trim());
    return fail(
      'INVALID_AMOUNT',
      tooPrecise
        ? `${network.symbol} supports up to ${network.amountDecimals} decimals.`
        : `How much ${network.symbol} should I send?`,
    );
  }
  const remaining = parseAmount(req.dailyRemaining, network) ?? 0n;
  if (amount > remaining) {
    return fail('OVER_DAILY_LIMIT', `That would exceed today's limit (${formatAmount(remaining, network)} left).`);
  }

  try {
    const [code, fees, balance, cap] = await Promise.all([
      deps.chain.getCode({ address: to }),
      deps.chain.estimateFeesPerGas(),
      deps.chain.getBalance({ address: req.wallet }),
      deps.chain.readContract({ address: req.beamPay, abi: BEAM_PAY_ABI, functionName: 'capFor', args: [req.wallet] }),
    ]);
    let transferGas: bigint;
    try {
      transferGas = await deps.chain.estimateGas({ account: req.wallet, to, value: amount });
    } catch {
      return fail('RECIPIENT_REJECTS', 'This address rejects payments.');
    }
    const gasLimit = ((transferGas + BEAM_PAY_OVERHEAD_GAS) * 110n) / 100n;
    const maxFee = fees.maxFeePerGas;
    const fee = gasLimit * maxFee;
    if (balance < amount + fee) {
      return fail(
        'INSUFFICIENT_BALANCE',
        `Not enough ${network.symbol} (balance ${formatAmount(balance, network)}, needed ${formatAmount(amount + fee, network, 6)} incl. fee).`,
      );
    }

    const isContract = !!code && code !== '0x';
    const warnings: IntentWarning[] = [];
    if (isContract) warnings.push('RECIPIENT_IS_CONTRACT');
    if (to === getAddress(req.wallet)) warnings.push('SELF_TRANSFER');
    if (recipient.toName && recipient.primaryName !== recipient.toName) warnings.push('NAME_NOT_PRIMARY');
    if (!amountAppears(amount, [...(req.context ? [req.context.text] : []), ...req.userTexts], network)) {
      warnings.push('AMOUNT_NOT_IN_CONTEXT');
    }
    if (req.parsedBy === 'fallback') warnings.push('PARSED_WITHOUT_AI');
    if (amount * 5n >= remaining * 4n) warnings.push('CLOSE_TO_DAILY_LIMIT');

    const approvalReasons: ApprovalReason[] = [];
    if (amount > cap) approvalReasons.push('OVER_CAP');
    if (req.origin === 'mcp') approvalReasons.push('EXTERNAL_AGENT');

    const now = req.now ?? Date.now();
    return {
      id: req.id,
      type: 'payment',
      network: network.key,
      chainId: network.chainId,
      to,
      ...(recipient.toName ? { toName: recipient.toName } : {}),
      amountWei: amount.toString(),
      amountDisplay: formatAmount(amount, network, network.amountDecimals),
      gasLimit: gasLimit.toString(),
      maxFeePerGasWei: maxFee.toString(),
      estFeeDisplay: formatAmount(fee, network, 6),
      intentHash: computeIntentHash(req.id, to, amount, network.chainId),
      route: approvalReasons.length ? 'payWithApproval' : 'pay',
      approvalReasons,
      provenance: {
        source: recipient.source,
        ...(req.context && recipient.source !== 'user' ? { appLabel: req.context.appLabel } : {}),
      },
      recipientIsContract: isContract,
      warnings,
      createdAt: now,
      expiresAt: now + INTENT_TTL_MS,
      parsedBy: req.parsedBy,
      origin: req.origin,
    };
  } catch (e) {
    return fail('RPC_ERROR', `Couldn't reach ${network.name}: ${(e as Error).message.split('\n')[0].slice(0, 120)}`);
  }
}

/**
 * Type guard separating a successful `prepareTransfer` result from an error.
 * @param r Result of `prepareTransfer`.
 * @returns True when `r` is a `TransferError`.
 */
export function isTransferError(r: Intent | TransferError): r is TransferError {
  return 'error' in r;
}

/**
 * Recomputes the route after device-only approval reasons are added.
 * @param intent Intent from `prepareTransfer` or the server.
 * @param extra Reasons only the device can know (`NEW_RECIPIENT`, `NAME_CHANGED`).
 * @returns The intent with merged reasons and the matching route.
 */
export function withApprovalReasons(intent: Intent, extra: ApprovalReason[]): Intent {
  const approvalReasons = [...new Set([...intent.approvalReasons, ...extra])];
  return { ...intent, approvalReasons, route: approvalReasons.length ? 'payWithApproval' : 'pay' };
}
