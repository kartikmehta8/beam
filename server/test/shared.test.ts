/**
 * @file Guards the shared-file contract (server copies equal the app copies byte
 * for byte) and unit-tests the shared network, intent, fallbackParser,
 * beamPay, ens and api modules. Risk and injection also have shared copies.
 */
import { readFileSync } from 'node:fs';
import { parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { decodeReviewLink, encodeReviewLink, REVIEW_LINK_PREFIX, validateHandleLabel, type ReviewLinkPayload } from '../src/api';
import { createNameResolver, extractEnsNames, normalizeEnsName } from '../src/ens';
import { chipLabel } from '../src/fallbackParser';
import { formatAmount, parseAmount, shortAddress, stripZeroWidth, toChecksumAddress, withApprovalReasons, type Intent } from '../src/intent';
import { addressUrl, getNetwork, NETWORKS, txUrl } from '../src/network';
import { APPROVAL_TYPES, beamPayDomain, BEAM_PAY_ABI, toSourceApp } from '../src/beamPay';
import { ARC, mockEns, NAMED, BEAM_PAY, RECIPIENT } from './helpers';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url));
const SHARED = ['network.ts', 'intent.ts', 'fallbackParser.ts', 'beamPay.ts', 'ens.ts', 'api.ts', 'risk.ts', 'injection.ts'];

describe('shared files', () => {
  it.each(SHARED)('server/src/%s equals app/src/%s', (name) => {
    expect(read(`../src/${name}`).equals(read(`../../app/src/${name}`))).toBe(true);
  });

  it.each(SHARED)('%s has no em or en dashes', (name) => {
    expect(read(`../src/${name}`).toString('utf8')).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('network.ts', () => {
  it('defaults to Arc; trims and ignores case', () => {
    expect(getNetwork(undefined)).toBe(NETWORKS.arc);
    expect(getNetwork('')).toBe(NETWORKS.arc);
    expect(getNetwork(' ARC ')).toBe(NETWORKS.arc);
  });

  it('rejects unknown networks at startup', () => {
    expect(() => getNetwork('base')).toThrow('Unsupported network');
  });

  it('constants match PLAN section 5', () => {
    expect(ARC).toMatchObject({ chainId: 5042002, symbol: 'USDC', amountDecimals: 6, displayDecimals: 2, dollarPrefix: true });
  });

  it('explorer links', () => {
    expect(txUrl(ARC, '0xab')).toBe(`${ARC.explorerUrl}/tx/0xab`);
    expect(addressUrl(ARC, RECIPIENT)).toBe(`https://explorer.testnet.arc.io/address/${RECIPIENT}`);
  });
});

describe('intent.ts amounts and addresses', () => {
  it.each([
    ['12', ARC, parseEther('12')],
    ['0.5', ARC, parseEther('0.5')],
    ['0.000001', ARC, 10n ** 12n],
    ['0.0000001', ARC, null],
    ['1e3', ARC, null],
    ['-1', ARC, null],
    ['$12', ARC, null],
    [' 7 ', ARC, parseEther('7')],
  ] as const)('parseAmount(%j) on %s', (value, network, expected) => {
    expect(parseAmount(value, network)).toBe(expected);
  });

  it('formatAmount: symbol, truncation, dust', () => {
    expect(formatAmount(parseEther('12.5'), ARC)).toBe('12.5 USDC');
    expect(formatAmount(parseEther('12.999'), ARC)).toBe('12.99 USDC');
    expect(formatAmount(parseEther('0.001'), ARC)).toBe('<0.01 USDC');
    expect(formatAmount(0n, ARC)).toBe('0 USDC');
  });

  it('toChecksumAddress: lowercase ok, bad mixed checksum rejected, zero-width stripped', () => {
    expect(toChecksumAddress(RECIPIENT.toLowerCase())).toBe(RECIPIENT);
    expect(toChecksumAddress(RECIPIENT.replace('a', 'A').replace('B', 'b'))).toBeNull();
    expect(toChecksumAddress(`${RECIPIENT.slice(0, 10)}​${RECIPIENT.slice(10)}`)).toBe(RECIPIENT);
    expect(stripZeroWidth('a​‌‍﻿b')).toBe('ab');
    expect(shortAddress(RECIPIENT)).toBe(`${RECIPIENT.slice(0, 6)}…1234`);
  });

  it('withApprovalReasons merges device reasons and flips the route', () => {
    const base = { approvalReasons: [], route: 'pay' } as unknown as Intent;
    expect(withApprovalReasons(base, [])).toMatchObject({ route: 'pay', approvalReasons: [] });
    const flipped = withApprovalReasons({ ...base, approvalReasons: ['OVER_CAP'] }, ['NEW_RECIPIENT', 'OVER_CAP']);
    expect(flipped).toMatchObject({ route: 'payWithApproval', approvalReasons: ['OVER_CAP', 'NEW_RECIPIENT'] });
  });
});

describe('fallbackParser.ts chipLabel', () => {
  it('shortens addresses, keeps other options', () => {
    expect(chipLabel(RECIPIENT)).toBe(shortAddress(RECIPIENT));
    expect(chipLabel('rahul.eth')).toBe('rahul.eth');
    expect(chipLabel('5 USDC')).toBe('5 USDC');
  });
});

describe('beamPay.ts', () => {
  it('domain and types match the contract', () => {
    expect(beamPayDomain(ARC.chainId, BEAM_PAY)).toEqual({ name: 'BeamPay', version: '1', chainId: 5042002, verifyingContract: BEAM_PAY });
    expect(APPROVAL_TYPES.PayApproval.map((f) => f.name)).toEqual(['payer', 'to', 'amount', 'intentHash', 'nonce', 'deadline']);
    expect(APPROVAL_TYPES.CapApproval.map((f) => f.name)).toEqual(['account', 'cap', 'nonce', 'deadline']);
    expect(APPROVAL_TYPES.HumanLink.map((f) => f.name)).toEqual(['account', 'humanHash', 'nonce', 'deadline']);
    const fns = BEAM_PAY_ABI.filter((x) => x.type === 'function').map((x) => x.name);
    expect(fns).toEqual(expect.arrayContaining(['pay', 'payWithApproval', 'capFor', 'humanOf', 'nonces', 'raiseCap', 'lowerCap', 'linkHuman']));
  });

  it('toSourceApp caps at 32 UTF-8 bytes without splitting a character', () => {
    expect(toSourceApp('WhatsApp')).toBe('WhatsApp');
    expect(toSourceApp('a'.repeat(40))).toHaveLength(32);
    const emoji = toSourceApp('x'.repeat(30) + '😀😀');
    expect(new TextEncoder().encode(emoji).length).toBeLessThanOrEqual(32);
    expect(emoji).toBe('x'.repeat(30));
  });
});

describe('ens.ts', () => {
  it('normalizes ENSIP-15 and rejects non-.eth or invalid names', () => {
    expect(normalizeEnsName('Rahul.ETH')).toBe('rahul.eth');
    expect(normalizeEnsName('rahul.orbpay.eth')).toBe('rahul.orbpay.eth');
    expect(normalizeEnsName('rahul.com')).toBeNull();
    expect(normalizeEnsName('bad\u0000name.eth')).toBeNull();
    expect(normalizeEnsName('.eth')).toBeNull();
  });

  it('extracts unique names with a leading guard, skipping emails and URLs', () => {
    expect(extractEnsNames('pay Rahul.eth, then (kartik.orbpay.eth) and rahul.eth again')).toEqual(['rahul.eth', 'kartik.orbpay.eth']);
    expect(extractEnsNames('mail me@rahul.eth or open rahul.eth.limo')).toEqual([]);
  });

  it('createNameResolver: chain coin type first, default fallback, reverse check, null when missing', async () => {
    const ens = mockEns({ 'rahul.eth': { chainAddress: NAMED, primary: 'Rahul.eth' }, 'dflt.eth': { defaultAddress: RECIPIENT } });
    const resolve = createNameResolver(ens, ARC.chainId);
    expect(await resolve('rahul.eth')).toEqual({ name: 'rahul.eth', address: NAMED, primaryName: 'rahul.eth' });
    expect(await resolve('dflt.eth')).toEqual({ name: 'dflt.eth', address: RECIPIENT, primaryName: null });
    expect(await resolve('none.eth')).toBeNull();
    expect(ens.getEnsAddress).toHaveBeenCalledWith({ name: 'rahul.eth', coinType: 2147483648n + 5042002n });
  });

  it('createNameResolver: a chain-specific primary name wins, else the default primary name (ENSIP-19)', async () => {
    const ens = mockEns({
      'rahul.eth': { chainAddress: NAMED, primary: 'rahul.eth' },
      'multi.eth': { defaultAddress: RECIPIENT, primary: 'old.eth', chainPrimary: 'multi.eth' },
    });
    const resolve = createNameResolver(ens, ARC.chainId);
    expect((await resolve('rahul.eth'))?.primaryName).toBe('rahul.eth');
    expect(ens.getEnsName).toHaveBeenCalledWith({ address: NAMED, coinType: 2147483648n + 5042002n });
    expect(ens.getEnsName).toHaveBeenCalledWith({ address: NAMED });
    expect((await resolve('multi.eth'))?.primaryName).toBe('multi.eth');
  });

  it('createNameResolver throws when the RPC fails (caller maps to NAME_UNAVAILABLE)', async () => {
    await expect(createNameResolver(mockEns({}, true), ARC.chainId)('rahul.eth')).rejects.toThrow();
  });
});

describe('api.ts', () => {
  it.each([
    ['kartik', { label: 'kartik' }],
    [' Kartik-01 ', { label: 'kartik-01' }],
    ['ab', { error: 'Use 3 to 20 characters.' }],
    ['a'.repeat(21), { error: 'Use 3 to 20 characters.' }],
    ['kar_tik', { error: 'Use letters, numbers and hyphens only.' }],
    ['-kartik', { error: "Handles can't start or end with a hyphen." }],
    ['kar--tik', { error: "Handles can't contain two hyphens in a row." }],
    ['admin', { error: 'That handle is reserved.' }],
  ])('validateHandleLabel(%j)', (raw, expected) => {
    expect(validateHandleLabel(raw)).toEqual(expected);
  });

  it('review links round-trip, including non-ASCII context', () => {
    const payload: ReviewLinkPayload = { v: 1, intentId: 'i-1', to: 'rahul.eth', amount: '60', context: 'Design invoice ₹ नमस्ते: $60 to rahul.eth' };
    const link = encodeReviewLink(payload);
    expect(link.startsWith(REVIEW_LINK_PREFIX)).toBe(true);
    expect(link.slice(REVIEW_LINK_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeReviewLink(link.slice(REVIEW_LINK_PREFIX.length))).toEqual(payload);
  });

  it('tampered or malformed review links decode to null', () => {
    const p = encodeReviewLink({ v: 1, intentId: 'i', to: RECIPIENT as Address, amount: '1', context: 'x' }).slice(REVIEW_LINK_PREFIX.length);
    expect(decodeReviewLink('%%%')).toBeNull();
    expect(decodeReviewLink(p.slice(0, -4))).toBeNull();
    const bad = (o: Record<string, unknown>) => btoa(JSON.stringify({ v: 1, intentId: 'i', to: 'a.eth', amount: '1', context: '', ...o })).replace(/=+$/, '');
    expect(decodeReviewLink(bad({ v: 2 }))).toBeNull();
    expect(decodeReviewLink(bad({ amount: '1e3' }))).toBeNull();
    expect(decodeReviewLink(bad({ context: 'x'.repeat(2001) }))).toBeNull();
    expect(decodeReviewLink(bad({}))).not.toBeNull();
  });
});
