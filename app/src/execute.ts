/**
 * @file Intent execution as a hook driving one intent card:
 * local checks → (World ID approval for `payWithApproval`) → biometric (or
 * hold-to-confirm) → chain check → re-check (names re-resolved) → BeamPay dry
 * run → sign and send through the Privy embedded wallet → persist pending → receipt.
 *
 * Sends are never retried. An intent is marked executed right before sending,
 * so it can never be sent twice, even if the receipt never arrives.
 */
import type { ConnectedEthereumWallet, PrivyEmbeddedWalletProvider } from '@privy-io/expo';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hash } from 'viem';
import { publicClient } from './chain';
import { config, NETWORK } from './config';
import { authenticate, getAuthMode, type AuthMode } from './deviceAuth';
import type { Intent } from './intent';
import { getLimitState } from './limits';
import { recheckName } from './names';
import {
  ensureChain,
  explainRevert,
  paymentData,
  readAccount,
  sendBeamPay,
  shortError,
  simulateBeamPay,
  walletClientFor,
  type Approval,
  type BeamPayTx,
} from './beamPayClient';
import { finalizePending, loadPending, savePending, settlePending, type PendingTx } from './pendingTx';
import { paymentAuthorizationError, type PaymentAuthorization } from './paymentAuthorization';
import { BEAMPAY_MISSING } from './prepare';
import { loadServerStatus, worldOf } from './serverApi';
import { isExecuted, markExecuted } from './storage';
import { validateIntent, type IntentCheck } from './validateIntent';

/** Card states, in order: idle → confirming → signing → submitted → terminal. */
export type ExecState =
  | { status: 'idle' }
  | { status: 'confirming' }
  | { status: 'signing' }
  | { status: 'submitted'; hash: Hash }
  /** `ms` runs from send to receipt; null when settled by "Check again". */
  | { status: 'confirmed'; hash: Hash; ms: number | null }
  | { status: 'failed'; reason: string; hash: Hash | null }
  | { status: 'pending_timeout'; hash: Hash }
  /** Biometric cancelled or failed; the card can be confirmed again. */
  | { status: 'cancelled' };

type IntentExecution = {
  state: ExecState;
  /** Null while the first check runs. */
  check: IntentCheck | null;
  /** Fresh balance from the last check. */
  balanceWei: bigint | null;
  /** BeamPay per-payment cap from the last check. */
  capWei: bigint | null;
  walletStatus: 'loading' | 'ready' | 'error';
  /** Null until device capabilities are known. */
  authMode: AuthMode | null;
  /** World ID approval held for a `payWithApproval` intent. */
  approval: Approval | null;
  /** Why a held approval was dropped (expired or no longer valid); cleared by a new approval. */
  approvalNote: string | null;
  /** Stores a fresh approval; checks re-run against its deadline. */
  setApproval: (approval: Approval) => void;
  /** Approves and sends. With `hold` auth, call it only after the hold completes. */
  confirm: () => Promise<void>;
  /** Re-runs the local checks (after a transient failure). */
  recheck: () => Promise<void>;
  /** Looks up the receipt once after `pending_timeout`. */
  checkAgain: () => Promise<void>;
};

const WALLET_TIMEOUT_MS = 10_000;
const RECEIPT_TIMEOUT_MS = 30_000;
const RPC_UNREACHABLE: IntentCheck = { ok: false, reason: `Couldn't reach ${NETWORK.name}. Check your connection.`, fix: 'retry' };
const WRONG_CHAIN: IntentCheck = { ok: false, reason: `Couldn't switch your wallet to ${NETWORK.name}.`, fix: 'retry' };

/**
 * Drives one intent card from local checks to a terminal state.
 * @param intent The locally prepared intent.
 * @param authorization Device-only permission from the active payment scope.
 * @param wallet Privy embedded wallet, or null while it is being created.
 * @param address Checksummed wallet address, or null.
 * @param onSettled Called once the payment confirms or reverts (refresh balances).
 * @returns State, checks and actions for the card.
 */
export function useIntentExecution(
  intent: Intent,
  authorization: PaymentAuthorization,
  wallet: ConnectedEthereumWallet | null,
  address: Address | null,
  onSettled?: () => void,
): IntentExecution {
  const [state, setState] = useState<ExecState>({ status: 'idle' });
  const [check, setCheck] = useState<IntentCheck | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [capWei, setCapWei] = useState<bigint | null>(null);
  const [provider, setProvider] = useState<PrivyEmbeddedWalletProvider | null>(null);
  const [walletError, setWalletError] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [approval, setApprovalState] = useState<Approval | null>(null);
  const [approvalNote, setApprovalNote] = useState<string | null>(null);
  const busy = useRef(false);
  const txRef = useRef<PendingTx | null>(null);
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const activeRef = useRef(true);
  const currentRef = useRef({ intent, authorization, address });
  currentRef.current = { intent, authorization, address };

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  // Async confirmation keeps old closures alive. Also compare against the
  // latest render so a changed wallet, intent or permission cannot use them.
  const authorizationCheck = useCallback((): IntentCheck | null => {
    const current = currentRef.current;
    if (!activeRef.current || current.authorization !== authorization || current.address !== address) {
      return { ok: false, reason: 'This payment context changed. Start a new payment.' };
    }
    if (!address) return { ok: false, reason: 'Sign in to Beam first.' };
    const reason = paymentAuthorizationError(authorization, intent, address)
      ?? paymentAuthorizationError(authorization, current.intent, address);
    return reason ? { ok: false, reason } : null;
  }, [authorization, intent, address]);

  useEffect(() => {
    void getAuthMode().then(setAuthMode);
  }, []);

  // Resolve the provider up front so Confirm is only enabled once signing can start (max 10 s).
  // Keyed on the address: Privy may hand back a new wallet object on every render.
  useEffect(() => {
    let alive = true;
    setProvider(null);
    setWalletError(false);
    const fail = () => alive && setWalletError(true);
    const timer = setTimeout(fail, WALLET_TIMEOUT_MS);
    walletRef.current?.getProvider().then((p) => {
      if (!alive) return;
      clearTimeout(timer);
      setProvider(p);
    }, fail);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [address]);

  const dropApproval = useCallback((note: string) => {
    setApprovalState(null);
    setApprovalNote(note);
  }, []);

  const setApproval = useCallback((next: Approval) => {
    setApprovalNote(null);
    setApprovalState(next);
  }, []);

  const runCheck = useCallback(async (): Promise<IntentCheck> => {
    const unauthorized = authorizationCheck();
    if (unauthorized) return unauthorized;
    if (!address) return { ok: false, reason: 'Sign in to Beam first.' };
    const { beamPay } = config;
    if (!beamPay) return { ok: false, reason: BEAMPAY_MISSING };
    try {
      const [balance, limits, account, server, name, executed, pending] = await Promise.all([
        publicClient.getBalance({ address }),
        getLimitState(),
        readAccount(beamPay, address),
        loadServerStatus(),
        intent.toName ? recheckName(intent.toName, intent.to) : null,
        isExecuted(intent.id),
        loadPending(),
      ]);
      const stale = authorizationCheck();
      if (stale) return stale;
      setBalanceWei(balance);
      setCapWei(account.cap);
      const result = validateIntent(intent, {
        balanceWei: balance,
        remainingWei: limits.remainingWei,
        capWei: account.cap,
        linked: account.linked,
        world: worldOf(server),
        name,
        approvalDeadline: approval?.deadline ?? null,
        executed,
        otherPending: !!pending && pending.hash !== txRef.current?.hash,
        now: Date.now(),
      });
      if (!result.ok && result.fix === 'reapprove') dropApproval(result.reason);
      return result;
    } catch {
      return RPC_UNREACHABLE;
    }
  }, [address, intent, approval, dropApproval, authorizationCheck]);

  const recheck = useCallback(async () => setCheck(await runCheck()), [runCheck]);

  // Check on mount (and when an approval arrives), and again the moment the intent or approval expires.
  useEffect(() => {
    let alive = true;
    const run = () => runCheck().then((c) => alive && setCheck(c));
    void run();
    const expiresAt = Math.min(intent.expiresAt, approval ? approval.deadline * 1000 : Infinity);
    const timer = setTimeout(run, Math.max(0, expiresAt - Date.now()) + 100);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [runCheck, intent.expiresAt, approval]);

  const confirm = useCallback(async () => {
    const { beamPay } = config;
    if (busy.current || !provider || !address || !authMode || !beamPay) return;
    if (intent.route === 'payWithApproval' && !approval) return;
    const unauthorized = authorizationCheck();
    if (unauthorized) {
      setCheck(unauthorized);
      return;
    }
    busy.current = true;
    try {
      if (authMode === 'biometric') {
        setState({ status: 'confirming' });
        if (!(await authenticate('Confirm payment'))) {
          setState({ status: 'cancelled' });
          return;
        }
      }

      setState({ status: 'signing' });
      const client = walletClientFor(provider);
      const fresh = (await ensureChain(client)) ? await runCheck() : WRONG_CHAIN;
      setCheck(fresh);
      if (!fresh.ok) {
        setState({ status: 'idle' });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      // Dry run first: a moved nonce, lowered cap or lapsed deadline reverts here, before anything is signed.
      const tx: BeamPayTx = { account: address, beamPay, data: paymentData(intent, approval), value: BigInt(intent.amountWei) };
      let revert: string | null;
      try {
        revert = await simulateBeamPay(tx);
      } catch {
        setCheck(RPC_UNREACHABLE);
        setState({ status: 'idle' });
        return;
      }
      if (revert) {
        if (approval) dropApproval(revert);
        else setCheck({ ok: false, reason: revert });
        setState({ status: 'idle' });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      const staleAfterSimulation = authorizationCheck();
      if (staleAfterSimulation) {
        setCheck(staleAfterSimulation);
        setState({ status: 'idle' });
        return;
      }
      await markExecuted(intent.id);
      const sentAt = Date.now();
      let hash: Hash;
      try {
        // Storage is async too. Check again immediately before sending, with
        // no intervening await where the UI could replace or revoke the scope.
        const staleBeforeSend = authorizationCheck();
        if (staleBeforeSend) {
          setCheck(staleBeforeSend);
          setState({ status: 'idle' });
          return;
        }
        hash = await sendBeamPay(client, tx, BigInt(intent.gasLimit), BigInt(intent.maxFeePerGasWei));
      } catch (e) {
        setState({ status: 'failed', reason: shortError(e), hash: null });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      const pendingTx: PendingTx = {
        hash,
        intentId: intent.id,
        to: intent.to,
        ...(intent.toName ? { toName: intent.toName } : {}),
        amountWei: intent.amountWei,
        sentAt,
      };
      txRef.current = pendingTx;
      // Persist before waiting so a dismissed sheet or killed app can resume it.
      await savePending(pendingTx).catch(() => undefined);
      setState({ status: 'submitted', hash });

      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 400, timeout: RECEIPT_TIMEOUT_MS });
        const ms = Date.now() - sentAt;
        await finalizePending(pendingTx, receipt.status).catch(() => undefined);
        if (receipt.status === 'success') {
          setState({ status: 'confirmed', hash, ms });
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          setState({ status: 'failed', reason: await explainRevert(tx, receipt.blockNumber), hash });
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
        settledRef.current?.();
      } catch {
        setState({ status: 'pending_timeout', hash });
      }
    } catch (e) {
      setState({ status: 'failed', reason: shortError(e), hash: txRef.current?.hash ?? null });
    } finally {
      busy.current = false;
    }
  }, [provider, address, authMode, intent, approval, runCheck, dropApproval, authorizationCheck]);

  const checkAgain = useCallback(async () => {
    const tx = txRef.current;
    if (busy.current || !tx) return;
    busy.current = true;
    setState({ status: 'submitted', hash: tx.hash });
    try {
      const result = await settlePending(publicClient, tx);
      if (result.kind === 'confirmed') {
        setState({ status: 'confirmed', hash: tx.hash, ms: null });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else if (result.kind === 'failed') {
        setState({ status: 'failed', reason: 'Transaction reverted. Nothing was sent.', hash: tx.hash });
      } else if (result.kind === 'unknown') {
        setState({ status: 'failed', reason: 'Status unknown. Check the explorer.', hash: tx.hash });
      } else {
        setState({ status: 'pending_timeout', hash: tx.hash });
      }
      if (result.kind === 'confirmed' || result.kind === 'failed') settledRef.current?.();
    } catch {
      setState({ status: 'pending_timeout', hash: tx.hash });
    } finally {
      busy.current = false;
    }
  }, []);

  return {
    state,
    check,
    balanceWei,
    capWei,
    walletStatus: provider ? 'ready' : walletError ? 'error' : 'loading',
    authMode,
    approval,
    approvalNote,
    setApproval,
    confirm,
    recheck,
    checkAgain,
  };
}
