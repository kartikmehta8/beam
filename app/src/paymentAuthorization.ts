/**
 * @file Device-only permission to review and execute a payment. Opaque objects
 * live in WeakMaps, so serialized intents and model output cannot create a
 * permission. The UI owns each scope and revokes it when its context changes.
 * No screen or conversation text is retained here.
 */
import type { Intent } from './intent';

declare const scopeBrand: unique symbol;
declare const authorizationBrand: unique symbol;

export type PaymentScope = { readonly [scopeBrand]: true };
export type PaymentAuthorization = { readonly [authorizationBrand]: true };

const SCOPE_TTL_MS = 5 * 60_000;
const REQUIRED = 'Start a new payment to review these details.';
const STALE = 'This payment context changed. Start a new payment.';
const EXPIRED = 'This payment review expired. Start a new payment.';

type ScopeState = { wallet: string; expiresAt: number; revoked: boolean };
type PaymentTuple = Pick<Intent, 'id' | 'to' | 'amountWei' | 'chainId' | 'network' | 'intentHash' | 'route'>;
type AuthorizationState = { scope: ScopeState; tuple: PaymentTuple; expiresAt: number };

const scopes = new WeakMap<PaymentScope, ScopeState>();
const authorizations = new WeakMap<PaymentAuthorization, AuthorizationState>();

/** Opens a five-minute review scope for the currently signed-in wallet. */
export function createPaymentScope(wallet: string, now = Date.now()): PaymentScope {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || !Number.isFinite(now)) throw new Error(REQUIRED);
  const scope = Object.freeze({}) as PaymentScope;
  scopes.set(scope, { wallet: wallet.toLowerCase(), expiresAt: now + SCOPE_TTL_MS, revoked: false });
  return scope;
}

/** Invalidates all payment permissions made from a scope; safe to call repeatedly. */
export function revokePaymentScope(scope: PaymentScope | null | undefined): void {
  const state = scope && typeof scope === 'object' ? scopes.get(scope) : undefined;
  if (state) state.revoked = true;
}

/** Creates a permission for the exact payment prepared by a deliberate UI action. */
export function authorizePayment(scope: PaymentScope, intent: Intent): PaymentAuthorization {
  const state = scope && typeof scope === 'object' ? scopes.get(scope) : undefined;
  if (!state) throw new Error(REQUIRED);
  if (state.revoked) throw new Error(STALE);
  const expiresAt = Math.min(state.expiresAt, intent.expiresAt);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw new Error(EXPIRED);
  const { id, to, amountWei, chainId, network, intentHash, route } = intent;
  const authorization = Object.freeze({}) as PaymentAuthorization;
  authorizations.set(authorization, {
    scope: state,
    tuple: { id, to, amountWei, chainId, network, intentHash, route },
    expiresAt,
  });
  return authorization;
}

/** Returns user-facing blocking copy, or null for a current, unchanged payment. */
export function paymentAuthorizationError(
  authorization: PaymentAuthorization | null | undefined,
  intent: Intent,
  wallet: string,
  now = Date.now(),
): string | null {
  const state = authorization && typeof authorization === 'object' ? authorizations.get(authorization) : undefined;
  if (!state) return REQUIRED;
  if (state.scope.revoked || wallet.toLowerCase() !== state.scope.wallet) return STALE;
  if (!Number.isFinite(now) || now >= state.expiresAt) return EXPIRED;
  const tuple = state.tuple;
  if (
    intent.id !== tuple.id || intent.to !== tuple.to || intent.amountWei !== tuple.amountWei ||
    intent.chainId !== tuple.chainId || intent.network !== tuple.network ||
    intent.intentHash !== tuple.intentHash || intent.route !== tuple.route
  ) return STALE;
  return null;
}
