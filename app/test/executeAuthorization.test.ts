/** Exercises the real execution hook's async authorization boundaries with a
 * small hook host; native UI, wallet and RPC dependencies remain mocked. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedEthereumWallet } from '@privy-io/expo';
import type { Address } from 'viem';
import type { Intent } from '../src/intent';
import { useIntentExecution } from '../src/execute';
import { authorizePayment, createPaymentScope, revokePaymentScope, type PaymentAuthorization } from '../src/paymentAuthorization';

const host = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
  cleanups: [] as (() => void)[],
}));

// Keep state and ref identity between renders and run effect cleanups. Tests
// intentionally pause real async boundaries in execute.ts, not copied logic.
vi.mock('react', () => ({
  useRef: (value: unknown) => {
    const i = host.cursor++;
    return host.slots[i] ?? (host.slots[i] = { current: value });
  },
  useState: (value: unknown) => {
    const i = host.cursor++;
    if (!(i in host.slots)) host.slots[i] = value;
    return [host.slots[i], (next: unknown) => { host.slots[i] = next; }];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const i = host.cursor++;
    const previous = host.slots[i] as unknown[] | undefined;
    if (previous && deps.length === previous.length && deps.every((v, n) => Object.is(v, previous[n]))) return;
    host.slots[i] = deps;
    host.effects.push(() => {
      host.cleanups[i]?.();
      host.cleanups[i] = effect() ?? (() => {});
    });
  },
}));

const mock = vi.hoisted(() => ({
  authenticate: vi.fn(), getAuthMode: vi.fn(), simulate: vi.fn(), mark: vi.fn(), send: vi.fn(),
  getBalance: vi.fn(), receipt: vi.fn(), provider: {},
}));

vi.mock('expo-haptics', () => ({ notificationAsync: vi.fn(), NotificationFeedbackType: { Error: 'error', Success: 'success' } }));
vi.mock('../src/config', () => ({ config: { beamPay: '0x3333333333333333333333333333333333333333' }, NETWORK: { name: 'Arc Testnet' } }));
vi.mock('../src/deviceAuth', () => ({ authenticate: mock.authenticate, getAuthMode: mock.getAuthMode }));
vi.mock('../src/chain', () => ({ publicClient: { getBalance: mock.getBalance, waitForTransactionReceipt: mock.receipt } }));
vi.mock('../src/limits', () => ({ getLimitState: async () => ({ remainingWei: 100n }) }));
vi.mock('../src/names', () => ({ recheckName: vi.fn() }));
vi.mock('../src/beamPayClient', () => ({
  ensureChain: async () => true, explainRevert: async () => 'revert', paymentData: () => '0x',
  readAccount: async () => ({ cap: 100n, linked: true }), sendBeamPay: mock.send,
  shortError: (e: Error) => e.message, simulateBeamPay: mock.simulate, walletClientFor: () => ({}),
}));
vi.mock('../src/pendingTx', () => ({ finalizePending: async () => {}, loadPending: async () => null, savePending: async () => {}, settlePending: vi.fn() }));
vi.mock('../src/prepare', () => ({ BEAMPAY_MISSING: 'missing' }));
vi.mock('../src/serverApi', () => ({ loadServerStatus: async () => ({}), worldOf: () => ({}) }));
vi.mock('../src/storage', () => ({ isExecuted: async () => false, markExecuted: mock.mark }));
vi.mock('../src/validateIntent', () => ({ validateIntent: () => ({ ok: true }) }));

const WALLET: Address = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET: Address = '0x2222222222222222222222222222222222222222';
const wallet = { getProvider: async () => mock.provider } as unknown as ConnectedEthereumWallet;

function intent(): Intent {
  return {
    id: 'one', type: 'payment', network: 'arc', chainId: 5042002, to: OTHER_WALLET,
    amountWei: '1', amountDisplay: '0.000001 USDC', gasLimit: '1', maxFeePerGasWei: '1', estFeeDisplay: '0',
    intentHash: `0x${'ab'.repeat(32)}`, route: 'pay', approvalReasons: [], provenance: { source: 'user' },
    recipientIsContract: false, warnings: [], createdAt: Date.now(), expiresAt: Date.now() + 300_000,
    parsedBy: 'fallback', origin: 'phone',
  };
}

function render(payment: Intent, authorization: PaymentAuthorization, address: Address = WALLET) {
  host.cursor = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- This test host supplies the mocked hook runtime above.
  const value = useIntentExecution(payment, authorization, wallet, address);
  host.effects.splice(0).forEach((effect) => effect());
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function ready() {
  const payment = intent();
  const scope = createPaymentScope(WALLET);
  const authorization = authorizePayment(scope, payment);
  render(payment, authorization);
  // Provider and authentication-mode effects settle before Confirm is enabled.
  await Promise.resolve();
  await Promise.resolve();
  const exec = render(payment, authorization);
  expect(exec.walletStatus).toBe('ready');
  return { payment, scope, authorization, exec };
}

describe('payment execution authorization', () => {
  beforeEach(() => {
    host.cleanups.forEach((cleanup) => cleanup?.());
    host.cursor = 0; host.slots = []; host.effects = []; host.cleanups = [];
    vi.resetAllMocks();
    mock.authenticate.mockResolvedValue(true);
    mock.getAuthMode.mockResolvedValue('hold');
    mock.getBalance.mockResolvedValue(100n);
    mock.simulate.mockResolvedValue(null);
    mock.mark.mockResolvedValue(undefined);
    mock.send.mockResolvedValue(`0x${'cd'.repeat(32)}`);
    mock.receipt.mockResolvedValue({ status: 'success', blockNumber: 1n });
  });

  it('sends once for a current permission', async () => {
    const { exec } = await ready();
    await exec.confirm();
    expect(mock.mark).toHaveBeenCalledOnce();
    expect(mock.send).toHaveBeenCalledOnce();
  });

  it('blocks an absent/forged permission before device confirmation', async () => {
    const { payment } = await ready();
    const exec = render(payment, {} as PaymentAuthorization);
    await exec.confirm();
    expect(mock.authenticate).not.toHaveBeenCalled();
    expect(mock.simulate).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });

  it('blocks a scope revoked during biometrics', async () => {
    mock.getAuthMode.mockResolvedValue('biometric');
    const auth = deferred<boolean>();
    mock.authenticate.mockReturnValue(auth.promise);
    const { scope, exec } = await ready();
    const confirmation = exec.confirm();
    expect(mock.authenticate).toHaveBeenCalledOnce();
    revokePaymentScope(scope);
    auth.resolve(true);
    await confirmation;
    expect(mock.simulate).not.toHaveBeenCalled();
    expect(mock.mark).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });

  it('blocks revocation while simulation is pending, before marking executed', async () => {
    const simulation = deferred<null>();
    mock.simulate.mockReturnValue(simulation.promise);
    const { scope, exec } = await ready();
    const confirmation = exec.confirm();
    await vi.waitFor(() => expect(mock.simulate).toHaveBeenCalledOnce());
    revokePaymentScope(scope);
    simulation.resolve(null);
    await confirmation;
    expect(mock.mark).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });

  it('blocks revocation during the async executed-marker write', async () => {
    const marked = deferred<void>();
    mock.mark.mockReturnValue(marked.promise);
    const { scope, exec } = await ready();
    const confirmation = exec.confirm();
    await vi.waitFor(() => expect(mock.mark).toHaveBeenCalledOnce());
    revokePaymentScope(scope);
    marked.resolve();
    await confirmation;
    expect(mock.send).not.toHaveBeenCalled();
  });

  it('blocks a stale confirmation after the wallet changes', async () => {
    const simulation = deferred<null>();
    mock.simulate.mockReturnValue(simulation.promise);
    const { payment, authorization, exec } = await ready();
    const confirmation = exec.confirm();
    await vi.waitFor(() => expect(mock.simulate).toHaveBeenCalledOnce());
    render(payment, authorization, OTHER_WALLET);
    simulation.resolve(null);
    await confirmation;
    expect(mock.mark).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });

  it('blocks a replaced payment tuple while simulation is pending', async () => {
    const simulation = deferred<null>();
    mock.simulate.mockReturnValue(simulation.promise);
    const { payment, authorization, exec } = await ready();
    const confirmation = exec.confirm();
    await vi.waitFor(() => expect(mock.simulate).toHaveBeenCalledOnce());
    render({ ...payment, amountWei: '2' }, authorization);
    simulation.resolve(null);
    await confirmation;
    expect(mock.mark).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });

  it('blocks an older callback after the UI replaces its authorization', async () => {
    const simulation = deferred<null>();
    mock.simulate.mockReturnValue(simulation.promise);
    const { payment, exec } = await ready();
    const confirmation = exec.confirm();
    await vi.waitFor(() => expect(mock.simulate).toHaveBeenCalledOnce());
    render(payment, authorizePayment(createPaymentScope(WALLET), payment));
    simulation.resolve(null);
    await confirmation;
    expect(mock.mark).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });

  it('blocks expiry during the final executed-marker write', async () => {
    const marked = deferred<void>();
    mock.mark.mockReturnValue(marked.promise);
    const { payment, exec } = await ready();
    const confirmation = exec.confirm();
    await vi.waitFor(() => expect(mock.mark).toHaveBeenCalledOnce());
    const clock = vi.spyOn(Date, 'now').mockReturnValue(payment.expiresAt + 1);
    try {
      marked.resolve();
      await confirmation;
      expect(mock.send).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('blocks a confirmation after its review card unmounts', async () => {
    const simulation = deferred<null>();
    mock.simulate.mockReturnValue(simulation.promise);
    const { exec } = await ready();
    const confirmation = exec.confirm();
    await vi.waitFor(() => expect(mock.simulate).toHaveBeenCalledOnce());
    host.cleanups.forEach((cleanup) => cleanup?.());
    simulation.resolve(null);
    await confirmation;
    expect(mock.mark).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });
});
