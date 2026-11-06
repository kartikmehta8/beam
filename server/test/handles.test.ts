/**
 * @file Beam handles: config, label rules, availability, claim (exact ENSv2 calls
 * and role grants), one handle per human, approval and chain error mapping.
 * The ENS client and registrar signer are mocks; no network.
 */
import { Hono } from 'hono';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, getAddress, toHex, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { labelhash, packetToBytes, toCoinType } from 'viem/ens';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHandlesConfig, type HandlesConfig } from '../src/handles/config';
import {
  ALL_ROLES,
  COIN_TYPE_DEFAULT,
  ENSV2_DEPLOYMENTS,
  NO_EXPIRY,
  permissionedRegistryAbi,
  permissionedResolverAbi,
  REGISTRY_ROLES,
  STATUS,
  verifiableFactoryAbi,
} from '../src/handles/ensv2';
import { HANDLE_OWNER_ROLES, REGISTRAR_ROOT_ROLES, resolverSalt } from '../src/handles/registrar';
import { createHandleRoutes } from '../src/handles/routes';
import { createHandleStore } from '../src/handles/store';

const WALLET = getAddress('0x1111111111111111111111111111111111111111');
const OTHER = getAddress('0x2222222222222222222222222222222222222222');
const REGISTRAR = getAddress('0x3333333333333333333333333333333333333333');
const RESOLVER = getAddress('0x4444444444444444444444444444444444444444');
const REGISTRY = getAddress('0x5555555555555555555555555555555555555555');
const HUMAN: Hex = `0x${'aa'.repeat(32)}`;
const TX1: Hex = `0x${'01'.repeat(32)}`;
const TX2: Hex = `0x${'02'.repeat(32)}`;
const KEY: Hex = `0x${'ab'.repeat(32)}`;

const env = (over: Record<string, string> = {}) => ({
  ENS_PARENT_NAME: 'BeamFi.eth',
  ENS_REGISTRAR_PRIVATE_KEY: KEY,
  ENS_HANDLE_REGISTRY: REGISTRY,
  HANDLES_STORE_PATH: join(mkdtempSync(join(tmpdir(), 'beam-handles-')), 'handles.json'),
  ...over,
});

type ChainState = { status: number; owner: Address; code?: Hex; failReads?: boolean };

/**
 * ENS client mock: answers the registrar's reads from `state`.
 * @param state Mutable chain state.
 * @returns Mock client and its spies.
 */
function mockEns(state: ChainState) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (state.failReads) throw new Error('HTTP request failed. URL: https://eth.example/v2/SECRETKEY');
    switch (functionName) {
      case 'getStatus':
        return state.status;
      case 'getState':
        return { status: state.status, expiry: 0n, latestOwner: state.owner, tokenId: 1n, resource: 1n };
      case 'getOwner':
        return state.owner;
      case 'predictProxyAddress':
        return RESOLVER;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  });
  const getCode = vi.fn(async () => state.code);
  const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success' }));
  const client = { readContract, getCode, waitForTransactionReceipt } as unknown as PublicClient;
  return { client, readContract, getCode, waitForTransactionReceipt };
}

describe('loadHandlesConfig', () => {
  it('is null when nothing is set', () => {
    expect(loadHandlesConfig({})).toBeNull();
  });

  it('throws when only part of the setup is present', () => {
    expect(() => loadHandlesConfig({ ENS_PARENT_NAME: 'beamfi.eth' })).toThrow(/ENS_REGISTRAR_PRIVATE_KEY, ENS_HANDLE_REGISTRY/);
  });

  it('defaults to mainnet ENSv2 deployments and the Arc network', () => {
    const config = loadHandlesConfig(env())!;
    expect(config.chain.id).toBe(1);
    expect(config.parentName).toBe('beamfi.eth');
    expect(config.contracts.verifiableFactory).toBe(getAddress(ENSV2_DEPLOYMENTS.mainnet.verifiableFactory));
    expect(config.contracts.permissionedResolverImpl).toBe(getAddress(ENSV2_DEPLOYMENTS.mainnet.permissionedResolverImpl));
    expect(config.network.chainId).toBe(5042002);
  });

  it('switches to Sepolia and rejects bad values', () => {
    expect(loadHandlesConfig(env({ ENS_CHAIN: 'sepolia' }))!.contracts.verifiableFactory).toBe(
      getAddress(ENSV2_DEPLOYMENTS.sepolia.verifiableFactory),
    );
    expect(() => loadHandlesConfig(env({ ENS_CHAIN: 'goerli' }))).toThrow(/ENS_CHAIN/);
    expect(() => loadHandlesConfig(env({ ENS_PARENT_NAME: 'beam.fi.eth' }))).toThrow(/\.eth name/);
    expect(() => loadHandlesConfig(env({ ENS_REGISTRAR_PRIVATE_KEY: '0x12' }))).toThrow(/32-byte/);
    expect(() => loadHandlesConfig(env({ ENS_HANDLE_REGISTRY: 'nope' }))).toThrow(/ENS_HANDLE_REGISTRY/);
  });
});

describe('role policy', () => {
  it('lets the registrar create and revoke only', () => {
    expect(REGISTRAR_ROOT_ROLES).toBe(REGISTRY_ROLES.REGISTRAR | REGISTRY_ROLES.UNREGISTER);
  });

  it('gives owners their resolver but no transfer right', () => {
    expect(HANDLE_OWNER_ROLES & REGISTRY_ROLES.SET_RESOLVER).toBeTruthy();
    expect(HANDLE_OWNER_ROLES & REGISTRY_ROLES.CAN_TRANSFER_ADMIN).toBe(0n);
  });
});

describe('handle routes', () => {
  let config: HandlesConfig;
  let chain: ChainState;
  let ens: ReturnType<typeof mockEns>;
  let send: ReturnType<typeof vi.fn>;
  let take: ReturnType<typeof vi.fn>;

  const app = (over: { config?: HandlesConfig | null } = {}) =>
    createHandleRoutes({
      ensClient: ens.client,
      takeHandleApproval: take as unknown as (id: string, wallet: Address) => { humanHash: Hex } | null,
      config: over.config === undefined ? config : over.config,
      writer: { account: REGISTRAR, send: send as unknown as (tx: { to: Address; data: Hex }) => Promise<Hex> },
    });
  const claim = (body: unknown, a = app()) =>
    a.request('/', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const okBody = { label: 'Kartik', wallet: WALLET.toLowerCase(), approvalId: 'appr_1' };

  beforeEach(() => {
    config = loadHandlesConfig(env())!;
    chain = { status: STATUS.AVAILABLE, owner: zeroAddress };
    ens = mockEns(chain);
    send = vi.fn().mockResolvedValueOnce(TX1).mockResolvedValueOnce(TX2);
    take = vi.fn(() => ({ humanHash: HUMAN }));
  });

  it('returns 503 HANDLES_NOT_CONFIGURED without config', async () => {
    const a = app({ config: null });
    for (const res of [await a.request('/kartik'), await a.request(`/?wallet=${WALLET}`), await claim(okBody, a)]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'HANDLES_NOT_CONFIGURED' });
    }
  });

  describe('GET /:label', () => {
    it('rejects bad and reserved labels without touching the chain', async () => {
      expect(await (await app().request('/ab')).json()).toEqual({
        label: 'ab',
        name: 'ab.beamfi.eth',
        available: false,
        reason: 'Use 3 to 20 characters.',
      });
      expect(await (await app().request('/admin')).json()).toMatchObject({ available: false, reason: 'That handle is reserved.' });
      expect(await (await app().request('/-kartik')).json()).toMatchObject({ available: false });
      expect(ens.readContract).not.toHaveBeenCalled();
    });

    it('reads the registry status', async () => {
      expect(await (await app().request('/Kartik')).json()).toEqual({ label: 'kartik', name: 'kartik.beamfi.eth', available: true });
      expect(ens.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: REGISTRY, functionName: 'getStatus', args: [BigInt(labelhash('kartik'))] }),
      );
      chain.status = STATUS.REGISTERED;
      expect(await (await app().request('/kartik')).json()).toMatchObject({ available: false, reason: 'That handle is taken.' });
    });

    it('maps RPC failures to 502 without leaking the RPC error', async () => {
      chain.failReads = true;
      const res = await app().request('/kartik');
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).toContain('HANDLE_CHAIN_ERROR');
      expect(text).not.toContain('SECRETKEY');
    });

    it('keeps its error mapping when mounted under /v1/handles', async () => {
      chain.failReads = true;
      const parent = new Hono().route('/v1/handles', app());
      const res = await parent.request('/v1/handles/kartik');
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: 'HANDLE_CHAIN_ERROR' });
    });
  });

  describe('POST /', () => {
    it('registers the subname, then deploys a wallet-owned resolver with the initial records', async () => {
      const res = await claim(okBody);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ name: 'kartik.beamfi.eth', txHash: TX1 });
      expect(take).toHaveBeenCalledWith('appr_1', WALLET);
      expect(send).toHaveBeenCalledTimes(2);

      // 1. register(label, owner, no subregistry, predicted resolver, owner roles, no expiry) on our registry.
      const [registerTx] = send.mock.calls[0] as [{ to: Address; data: Hex }];
      expect(registerTx.to).toBe(REGISTRY);
      const register = decodeFunctionData({ abi: permissionedRegistryAbi, data: registerTx.data });
      expect(register.functionName).toBe('register');
      expect(register.args).toEqual(['kartik', WALLET, zeroAddress, RESOLVER, HANDLE_OWNER_ROLES, NO_EXPIRY]);
      expect(ens.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'predictProxyAddress', args: [REGISTRAR, resolverSalt('kartik.beamfi.eth', WALLET)] }),
      );

      // 2. deployProxy(PermissionedResolverImpl, salt, initialize(grants, calls)) on the VerifiableFactory.
      const [deployTx] = send.mock.calls[1] as [{ to: Address; data: Hex }];
      expect(deployTx.to).toBe(config.contracts.verifiableFactory);
      const deploy = decodeFunctionData({ abi: verifiableFactoryAbi, data: deployTx.data });
      expect(deploy.functionName).toBe('deployProxy');
      const [impl, salt, initData] = deploy.args as readonly [Address, bigint, Hex];
      expect(impl).toBe(config.contracts.permissionedResolverImpl);
      expect(salt).toBe(resolverSalt('kartik.beamfi.eth', WALLET));

      const init = decodeFunctionData({ abi: permissionedResolverAbi, data: initData });
      expect(init.functionName).toBe('initialize');
      const [grants, calls] = init.args as readonly [readonly { account: Address; roleBitmap: bigint }[], readonly Hex[]];
      // Every resolver role goes to the wallet; the registrar gets none.
      expect(grants).toEqual([{ account: WALLET, roleBitmap: ALL_ROLES }]);
      expect(grants.some((g) => g.account === REGISTRAR)).toBe(false);

      const dnsName = toHex(packetToBytes('kartik.beamfi.eth'));
      const records = calls.map((data) => {
        const call = decodeFunctionData({ abi: permissionedResolverAbi, data });
        return [call.functionName, ...(call.args as readonly unknown[])];
      });
      expect(records).toEqual([
        ['setAddress', dnsName, toCoinType(5042002), WALLET.toLowerCase()],
        ['setAddress', dnsName, COIN_TYPE_DEFAULT, WALLET.toLowerCase()],
        ['setText', dnsName, 'beam.network', 'arc'],
        ['setText', dnsName, 'beam.token', 'USDC'],
        ['setText', dnsName, 'url', config.repoUrl],
      ]);

      // Persisted per human.
      const file = JSON.parse(readFileSync(config.storePath, 'utf8')) as { handles: Record<string, { label: string }> };
      expect(file.handles[HUMAN].label).toBe('kartik');
    });

    it('returns the existing handle to the same human without a transaction', async () => {
      await claim(okBody);
      send.mockClear();
      const res = await claim({ ...okBody, label: 'another', approvalId: 'appr_2' });
      expect(await res.json()).toEqual({ name: 'kartik.beamfi.eth' });
      expect(send).not.toHaveBeenCalled();

      // Survives a restart: a new store on the same file still knows this human.
      expect(createHandleStore(config.storePath).byHuman(HUMAN)?.label).toBe('kartik');
    });

    it('resumes a half-finished claim without re-sending done steps', async () => {
      chain.status = STATUS.REGISTERED;
      chain.owner = WALLET;
      chain.code = '0x6001';
      const res = await claim(okBody);
      expect(await res.json()).toEqual({ name: 'kartik.beamfi.eth' });
      expect(send).not.toHaveBeenCalled();
    });

    it('returns 409 HANDLE_TAKEN when someone else holds the label', async () => {
      chain.status = STATUS.REGISTERED;
      chain.owner = OTHER;
      const res = await claim(okBody);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'HANDLE_TAKEN' });
      expect(send).not.toHaveBeenCalled();
    });

    it('rejects an invalid label before using the approval', async () => {
      const res = await claim({ ...okBody, label: 'wallet' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'HANDLE_INVALID', message: 'That handle is reserved.' });
      expect(take).not.toHaveBeenCalled();
    });

    it('rejects malformed bodies', async () => {
      const res = await claim({ label: 'kartik', wallet: '0x123', approvalId: 'a' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'BAD_REQUEST' });
    });

    it('returns 403 NOT_LINKED without a completed approval', async () => {
      take.mockReturnValue(null);
      const res = await claim(okBody);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'NOT_LINKED' });
      expect(send).not.toHaveBeenCalled();
    });

    it('maps approval errors thrown by the approvals module', async () => {
      take.mockImplementation(() => {
        throw Object.assign(new Error('This approval was already used.'), { code: 'APPROVAL_USED' });
      });
      const res = await claim(okBody);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'APPROVAL_USED', message: 'This approval was already used.' });
    });

    it('maps a failed transaction to 502 and stores nothing', async () => {
      send.mockReset().mockRejectedValue(new Error(`execution reverted, signer key ${KEY}`));
      const res = await claim(okBody);
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).toContain('HANDLE_CHAIN_ERROR');
      expect(text).not.toContain(KEY.slice(2, 12));
      expect(createHandleStore(config.storePath).byHuman(HUMAN)).toBeUndefined();
    });

    it('maps a reverted receipt to 502', async () => {
      ens.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
      const res = await claim(okBody);
      expect(res.status).toBe(502);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /?wallet=', () => {
    it('finds the handle only while the wallet still owns it onchain', async () => {
      await claim(okBody);
      chain.owner = WALLET;
      expect(await (await app().request(`/?wallet=${WALLET}`)).json()).toEqual({ name: 'kartik.beamfi.eth' });
      chain.owner = zeroAddress; // revoked
      expect(await (await app().request(`/?wallet=${WALLET}`)).json()).toEqual({ name: null });
      expect(await (await app().request(`/?wallet=${OTHER}`)).json()).toEqual({ name: null });
    });

    it('requires a valid wallet', async () => {
      const res = await app().request('/?wallet=nope');
      expect(res.status).toBe(400);
    });
  });
});
