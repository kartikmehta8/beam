import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Intent } from '../src/intent';
import {
  authorizePayment,
  createPaymentScope,
  paymentAuthorizationError,
  revokePaymentScope,
  type PaymentAuthorization,
  type PaymentScope,
} from '../src/paymentAuthorization';

const NOW = 1_800_000_000_000;
const WALLET = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const intent = (): Intent => ({
  id: 'payment-1', type: 'payment', network: 'arc', chainId: 5042002,
  to: '0x1111111111111111111111111111111111111111',
  amountWei: '1000000000000000000', amountDisplay: '1 USDC',
  gasLimit: '100000', maxFeePerGasWei: '1', estFeeDisplay: '0.01 USDC',
  intentHash: `0x${'ab'.repeat(32)}`, route: 'pay', approvalReasons: [],
  provenance: { source: 'user' }, recipientIsContract: false, warnings: [],
  createdAt: NOW, expiresAt: NOW + 300_000, parsedBy: 'fallback', origin: 'phone',
});

describe('device payment authorization', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it('accepts the reviewed tuple and wallet, including an equivalent wallet checksum', () => {
    const payment = intent();
    const authorization = authorizePayment(createPaymentScope(WALLET), payment);
    expect(paymentAuthorizationError(authorization, { ...payment }, WALLET)).toBeNull();
    expect(paymentAuthorizationError(authorization, payment, `0x${WALLET.slice(2).toUpperCase()}`)).toBeNull();
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(Object.keys(authorization)).toEqual([]);
  });

  it('rejects missing, forged, copied and JSON-roundtripped tokens', () => {
    const payment = intent();
    const authorization = authorizePayment(createPaymentScope(WALLET), payment);
    for (const token of [null, undefined, {}, { ...authorization }, JSON.parse(JSON.stringify(authorization)), 'approved']) {
      expect(paymentAuthorizationError(token as PaymentAuthorization, payment, WALLET)).not.toBeNull();
    }
    expect(() => authorizePayment({} as PaymentScope, payment)).toThrow();
  });

  it.each([
    ['id', 'payment-2'], ['to', OTHER_WALLET], ['amountWei', '2000000000000000000'],
    ['chainId', 1], ['network', 'other'], ['intentHash', `0x${'cd'.repeat(32)}`], ['route', 'payWithApproval'],
  ])('rejects a changed %s', (key, value) => {
    const payment = intent();
    const authorization = authorizePayment(createPaymentScope(WALLET), payment);
    expect(paymentAuthorizationError(authorization, { ...payment, [key]: value }, WALLET)).not.toBeNull();
  });

  it('snapshots values rather than trusting a mutable intent reference', () => {
    const payment = intent();
    const authorization = authorizePayment(createPaymentScope(WALLET), payment);
    payment.amountWei = '999000000000000000000';
    expect(paymentAuthorizationError(authorization, payment, WALLET)).not.toBeNull();
  });

  it('rejects a different wallet', () => {
    const payment = intent();
    const authorization = authorizePayment(createPaymentScope(WALLET), payment);
    expect(paymentAuthorizationError(authorization, payment, OTHER_WALLET)).not.toBeNull();
  });

  it('expires at five minutes even if the intent expires later', () => {
    const payment = { ...intent(), expiresAt: NOW + 900_000 };
    const authorization = authorizePayment(createPaymentScope(WALLET), payment);
    expect(paymentAuthorizationError(authorization, payment, WALLET, NOW + 299_999)).toBeNull();
    expect(paymentAuthorizationError(authorization, payment, WALLET, NOW + 300_000)).not.toBeNull();
  });

  it('expires at the earlier intent deadline and cannot extend it by editing the intent', () => {
    const payment = { ...intent(), expiresAt: NOW + 1000 };
    const authorization = authorizePayment(createPaymentScope(WALLET), payment);
    payment.expiresAt = NOW + 900_000;
    expect(paymentAuthorizationError(authorization, payment, WALLET, NOW + 1000)).not.toBeNull();
  });

  it('revokes every token in its scope while keeping an unrelated scope usable', () => {
    const payment = intent();
    const scope = createPaymentScope(WALLET);
    const first = authorizePayment(scope, payment);
    const second = authorizePayment(scope, payment);
    const independent = authorizePayment(createPaymentScope(WALLET), payment);
    revokePaymentScope(scope);
    revokePaymentScope(scope);
    revokePaymentScope(null);
    revokePaymentScope(undefined);
    expect(paymentAuthorizationError(first, payment, WALLET)).not.toBeNull();
    expect(paymentAuthorizationError(second, payment, WALLET)).not.toBeNull();
    expect(paymentAuthorizationError(independent, payment, WALLET)).toBeNull();
    expect(() => authorizePayment(scope, payment)).toThrow();
  });

  it('cannot issue a permission from an expired scope or expired intent', () => {
    const scope = createPaymentScope(WALLET);
    vi.setSystemTime(NOW + 300_000);
    expect(() => authorizePayment(scope, { ...intent(), expiresAt: NOW + 900_000 })).toThrow();
    expect(() => authorizePayment(createPaymentScope(WALLET), intent())).toThrow();
  });
});
