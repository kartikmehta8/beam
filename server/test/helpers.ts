/**
 * @file Test doubles: a stubbed chain client (including BeamPay reads), a stubbed
 * ENS reader, scripted Anthropic responses and request builders. No network.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { getAddress, parseEther, TransactionReceiptNotFoundError, zeroHash, type Address, type Hex } from 'viem';
import { vi } from 'vitest';
import type { CreateMessage } from '../src/agent';
import type { ChainClient } from '../src/chain';
import type { EnsReader } from '../src/ens';
import { NETWORKS } from '../src/network';
import type { AgentRequest } from '../src/schemas';
import type { ToolCtx } from '../src/tools/tool';

export const ARC = NETWORKS.arc;
export const WALLET = getAddress('0x1111111111111111111111111111111111111111');
export const RECIPIENT = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdef1234');
export const OTHER = getAddress('0x9876543210987654321098765432109876543210');
export const BEAM_PAY = getAddress('0x2222222222222222222222222222222222222222');
export const NAMED = getAddress('0x3333333333333333333333333333333333333333');
const MAX_FEE = 100_000_000_000n; // 100 gwei

export type ChainOpts = {
  code?: Hex;
  balance?: bigint;
  gas?: bigint;
  fail?: boolean;
  /** `BeamPay.capFor(wallet)`; defaults to 25 tokens. */
  cap?: bigint;
  /** `BeamPay.humanOf(wallet)`; defaults to unlinked. */
  humanOf?: Hex;
  /** `BeamPay.nonces(wallet)`. */
  nonce?: bigint;
};

/**
 * Chain stub with sane defaults: recipient is an EOA, wallet holds 100 tokens, cap 25.
 * @param opts Overrides.
 * @returns A ChainClient whose methods are vi.fn spies.
 */
export function mockChain(opts: ChainOpts = {}) {
  const fail = () => Promise.reject(new Error('rpc down'));
  const reads: Record<string, unknown> = {
    capFor: opts.cap ?? parseEther('25'),
    humanOf: opts.humanOf ?? zeroHash,
    nonces: opts.nonce ?? 0n,
  };
  return {
    getCode: vi.fn(() => (opts.fail ? fail() : Promise.resolve(opts.code))),
    getBalance: vi.fn(() => Promise.resolve(opts.balance ?? parseEther('100'))),
    estimateGas: vi.fn(() => Promise.resolve(opts.gas ?? 30_000n)),
    estimateFeesPerGas: vi.fn(() => Promise.resolve({ maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: 1n })),
    readContract: vi.fn(({ functionName }: { functionName: string }) => (opts.fail ? fail() : Promise.resolve(reads[functionName]))),
    getTransactionCount: vi.fn(() => Promise.resolve(7)),
    getTransactionReceipt: vi.fn(({ hash }: { hash: Hex }) =>
      hash.endsWith('0')
        ? Promise.reject(new TransactionReceiptNotFoundError({ hash }))
        : Promise.resolve({ status: 'success', blockNumber: 42n }),
    ),
  } as unknown as ChainClient & Record<string, ReturnType<typeof vi.fn>>;
}

/** An ENS record: chain-specific and default addresses, and the address's default and chain-specific primary names. */
export type EnsRecord = { chainAddress?: Address; defaultAddress?: Address; primary?: string; chainPrimary?: string };

/**
 * ENS stub. `getEnsAddress` and `getEnsName` with a coinType return the chain-specific
 * record, without one the default, like ENS's ENSIP-11 / ENSIP-19 split.
 * @param records Name to record.
 * @param fail When true, every call rejects (RPC down).
 * @returns An EnsReader whose methods are vi.fn spies.
 */
export function mockEns(records: Record<string, EnsRecord> = {}, fail = false) {
  const primaries = new Map<string, string>();
  const chainPrimaries = new Map<string, string>();
  for (const r of Object.values(records)) {
    const a = (r.chainAddress ?? r.defaultAddress)?.toLowerCase();
    if (a && r.primary) primaries.set(a, r.primary);
    if (a && r.chainPrimary) chainPrimaries.set(a, r.chainPrimary);
  }
  return {
    getEnsAddress: vi.fn(async ({ name, coinType }: { name: string; coinType?: bigint }) => {
      if (fail) throw new Error('ens rpc down');
      const r = records[name];
      return (coinType === undefined ? r?.defaultAddress : r?.chainAddress) ?? null;
    }),
    getEnsName: vi.fn(async ({ address, coinType }: { address: Address; coinType?: bigint }) => {
      if (fail) throw new Error('ens rpc down');
      return (coinType === undefined ? primaries : chainPrimaries).get(address.toLowerCase()) ?? null;
    }),
  } as unknown as EnsReader & Record<string, ReturnType<typeof vi.fn>>;
}

/** Default screen text: 12 USDC to RECIPIENT. */
export const SCREEN_TEXT = `dinner was 12 USDC, send to ${RECIPIENT}`;

/**
 * Tool context for direct tool tests (Arc, phone origin).
 * @param over Field overrides.
 * @returns A fresh ToolCtx.
 */
export function makeCtx(over: Partial<ToolCtx> = {}): ToolCtx {
  return {
    action: 'pay',
    chain: mockChain(),
    ens: mockEns(),
    network: ARC,
    beamPay: BEAM_PAY,
    wallet: WALLET,
    dailyRemaining: '100',
    origin: 'phone',
    context: { source: 'screen', appLabel: 'WhatsApp', text: SCREEN_TEXT },
    userTexts: ['pay this'],
    intents: [],
    clarification: null,
    assessment: null,
    ...over,
  };
}

/**
 * A valid agent request (parsed form, Arc).
 * @param over Field overrides.
 * @returns AgentRequest.
 */
export function makeRequest(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    requestId: 't1',
    action: 'pay',
    messages: [{ role: 'user', text: 'pay this' }],
    context: { source: 'screen', appLabel: 'WhatsApp', text: SCREEN_TEXT, capturedAt: 0 },
    wallet: { address: WALLET, chainId: ARC.chainId },
    limits: { dailyRemaining: '100' },
    ...over,
  };
}

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown };

/**
 * Builds a Messages API response.
 * @param blocks Text and tool_use blocks.
 * @returns A Message; stop_reason is tool_use when any tool_use block is present.
 */
export function msg(...blocks: Block[]): Anthropic.Message {
  const content = blocks.map((b, i) => (b.type === 'tool_use' ? { ...b, id: `toolu_${i}` } : b));
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content,
    stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

/**
 * A CreateMessage that replays scripted responses in order (repeating the last).
 * @param script Responses, or an Error to throw.
 * @returns Spy function.
 */
export function scripted(...script: (Anthropic.Message | Error)[]) {
  let i = 0;
  return vi.fn<CreateMessage>(async () => {
    const next = script[Math.min(i++, script.length - 1)];
    if (next instanceof Error) throw next;
    return next as Anthropic.Message;
  });
}
