/**
 * @file The Beam handle registrar: checks availability, finds a wallet's handle
 * and claims `<label>.<parent>` on ENSv2.
 *
 * A claim is two transactions from the registrar key:
 * 1. `register(label, wallet, …)` on our subname registry (a PermissionedRegistry).
 *    The wallet gets the name with SET_RESOLVER only: no CAN_TRANSFER_ADMIN, so the
 *    handle is non-transferable. The resolver is the CREATE2 address of step 2.
 * 2. `VerifiableFactory.deployProxy(PermissionedResolverImpl, …)` with
 *    `initialize([{ wallet, ALL_ROLES }], [initial records])`. Initialization skips
 *    role checks, so the records are written while every role goes to the wallet.
 *    The registrar key never holds a role on the resolver: Beam cannot redirect payments.
 *
 * Registering first claims the label before any gas is spent on the resolver. Both
 * steps are resumable: a retry skips a name already registered to the same wallet
 * and a resolver already deployed at its predicted address.
 */
import {
  createWalletClient,
  custom,
  encodeAbiParameters,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { labelhash, namehash, packetToBytes, toCoinType } from 'viem/ens';
import { validateHandleLabel, type ApiErrorCode, type HandleAvailability, type HandleClaim, type HandleLookup } from '../api';
import type { HandlesConfig } from './config';
import {
  admin,
  ALL_ROLES,
  COIN_TYPE_DEFAULT,
  NO_EXPIRY,
  permissionedRegistryAbi,
  permissionedResolverAbi,
  REGISTRY_ROLES,
  STATUS,
  verifiableFactoryAbi,
} from './ensv2';
import type { HandleStore } from './store';

/** Root roles the registrar key holds on our registry: create and revoke handles, nothing else. */
export const REGISTRAR_ROOT_ROLES = REGISTRY_ROLES.REGISTRAR | REGISTRY_ROLES.UNREGISTER;
/**
 * Root roles the parent owner (cold key, used at setup) keeps on our registry: rotate the
 * registrar key and set the registry's canonical parent. No upgrade, resolver or subregistry roles.
 */
export const PARENT_OWNER_ROOT_ROLES =
  admin(REGISTRY_ROLES.REGISTRAR) | admin(REGISTRY_ROLES.UNREGISTER) | REGISTRY_ROLES.SET_PARENT;
/** Roles each handle owner gets on their name: point it at another resolver. Not transferable. */
export const HANDLE_OWNER_ROLES = REGISTRY_ROLES.SET_RESOLVER | admin(REGISTRY_ROLES.SET_RESOLVER);

/** An error with the API code and HTTP status the route should return. */
export class HandleError extends Error {
  /**
   * @param code Wire error code.
   * @param status HTTP status.
   * @param message User-facing message (never raw RPC text).
   */
  constructor(
    readonly code: ApiErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 410 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'HandleError';
  }
}

const chainError = () => new HandleError('HANDLE_CHAIN_ERROR', 502, "Couldn't reach ENS on Ethereum. Try again in a minute.");

/** The chain reads the registrar makes. A viem PublicClient satisfies it. */
export type HandleReader = Pick<PublicClient, 'readContract' | 'getCode' | 'waitForTransactionReceipt'>;

/** Sends transactions from the registrar key. */
export type HandleWriter = { account: Address; send: (tx: { to: Address; data: Hex }) => Promise<Hex> };

/** Handle operations used by the routes. */
export type HandleRegistrar = {
  availability: (label: string) => Promise<HandleAvailability>;
  lookupByWallet: (wallet: Address) => Promise<HandleLookup>;
  claim: (req: { label: string; wallet: Address; humanHash: Hex }) => Promise<HandleClaim>;
};

/**
 * Builds the registrar key's signer, sending through the ENS client's transport.
 * @param ensClient Mainnet or Sepolia PublicClient.
 * @param config Handle config (key and chain).
 * @returns A writer.
 */
export function createHandleWriter(ensClient: PublicClient, config: HandlesConfig): HandleWriter {
  const account = privateKeyToAccount(config.registrarKey);
  const wallet = createWalletClient({ account, chain: config.chain, transport: custom(ensClient) });
  return { account: account.address, send: (tx) => wallet.sendTransaction(tx) };
}

/**
 * CREATE2 salt for a handle's resolver. Includes the wallet so a resolver is never
 * reused for a different owner of the same label.
 * @param name Full handle, e.g. "kartik.beamfi.eth".
 * @param wallet Handle owner.
 * @returns Salt for `deployProxy`.
 */
export function resolverSalt(name: string, wallet: Address): bigint {
  const tag = keccak256(stringToHex('BeamHandleResolver'));
  return BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }], [tag, namehash(name), wallet])));
}

/**
 * `initialize` calldata for a handle's Permissioned Resolver: all roles to the wallet,
 * plus the initial records (written during init, when role checks are skipped).
 * @param name Full handle.
 * @param wallet Handle owner.
 * @param config Network and repo URL for the records.
 * @returns Calldata for `deployProxy`'s `data` argument.
 */
export function resolverInitData(name: string, wallet: Address, config: Pick<HandlesConfig, 'network' | 'repoUrl'>): Hex {
  const dnsName = toHex(packetToBytes(name));
  const setAddress = (coinType: bigint) =>
    encodeFunctionData({ abi: permissionedResolverAbi, functionName: 'setAddress', args: [dnsName, coinType, wallet] });
  const setText = (key: string, value: string) =>
    encodeFunctionData({ abi: permissionedResolverAbi, functionName: 'setText', args: [dnsName, key, value] });
  const calls = [
    setAddress(toCoinType(config.network.chainId)),
    setAddress(COIN_TYPE_DEFAULT),
    setText('beam.network', config.network.key),
    setText('beam.token', config.network.symbol),
    setText('url', config.repoUrl),
  ];
  return encodeFunctionData({
    abi: permissionedResolverAbi,
    functionName: 'initialize',
    args: [[{ account: wallet, roleBitmap: ALL_ROLES }], calls],
  });
}

/**
 * Creates the registrar.
 * @param deps Chain reader, registrar signer, config and the per-human store.
 * @returns Handle operations.
 */
export function createHandleRegistrar(deps: {
  reader: HandleReader;
  writer: HandleWriter;
  config: HandlesConfig;
  store: HandleStore;
}): HandleRegistrar {
  const { reader, writer, config, store } = deps;
  const nameOf = (label: string) => `${label}.${config.parentName}`;
  const labelId = (label: string) => BigInt(labelhash(label));

  // ponytail: claims run one at a time in this process (one nonce, one store); a queue or DB lock if this scales out.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  /** Runs chain work; anything but a HandleError becomes a short 502 (no RPC text, no keys). */
  const onChain = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HandleError) throw err;
      throw chainError();
    }
  };

  const send = async (to: Address, data: Hex): Promise<Hex> => {
    const hash = await writer.send({ to, data });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw chainError();
    return hash;
  };

  return {
    async availability(raw) {
      const valid = validateHandleLabel(raw);
      if ('error' in valid) {
        const label = raw.trim().toLowerCase();
        return { label, name: nameOf(label), available: false, reason: valid.error };
      }
      const { label } = valid;
      const status = await onChain(() =>
        reader.readContract({ address: config.registry, abi: permissionedRegistryAbi, functionName: 'getStatus', args: [labelId(label)] }),
      );
      return status === STATUS.AVAILABLE
        ? { label, name: nameOf(label), available: true }
        : { label, name: nameOf(label), available: false, reason: 'That handle is taken.' };
    },

    async lookupByWallet(wallet) {
      const record = store.byWallet(wallet);
      if (!record) return { name: null };
      // The chain is the truth: a revoked handle no longer counts.
      const owner = await onChain(() =>
        reader.readContract({ address: config.registry, abi: permissionedRegistryAbi, functionName: 'getOwner', args: [labelId(record.label)] }),
      );
      return { name: isAddressEqual(owner, wallet) ? nameOf(record.label) : null };
    },

    claim({ label: raw, wallet, humanHash }) {
      const valid = validateHandleLabel(raw);
      if ('error' in valid) return Promise.reject(new HandleError('HANDLE_INVALID', 400, valid.error));
      const { label } = valid;
      const name = nameOf(label);

      return serialize(async () => {
        const existing = store.byHuman(humanHash);
        if (existing) return { name: nameOf(existing.label) };

        const txHash = await onChain(async () => {
          const state = await reader.readContract({
            address: config.registry,
            abi: permissionedRegistryAbi,
            functionName: 'getState',
            args: [labelId(label)],
          });
          const resumed = state.status === STATUS.REGISTERED && isAddressEqual(state.latestOwner, wallet);
          if (!resumed && state.status !== STATUS.AVAILABLE) throw new HandleError('HANDLE_TAKEN', 409, 'That handle is taken.');

          const salt = resolverSalt(name, wallet);
          const resolver = await reader.readContract({
            address: config.contracts.verifiableFactory,
            abi: verifiableFactoryAbi,
            functionName: 'predictProxyAddress',
            args: [writer.account, salt],
          });

          let txHash: Hex | undefined;
          if (!resumed) {
            txHash = await send(
              config.registry,
              encodeFunctionData({
                abi: permissionedRegistryAbi,
                functionName: 'register',
                args: [label, wallet, zeroAddress, resolver, HANDLE_OWNER_ROLES, NO_EXPIRY],
              }),
            );
          }
          const code = await reader.getCode({ address: resolver });
          if (!code || code === '0x') {
            const deployHash = await send(
              config.contracts.verifiableFactory,
              encodeFunctionData({
                abi: verifiableFactoryAbi,
                functionName: 'deployProxy',
                args: [config.contracts.permissionedResolverImpl, salt, resolverInitData(name, wallet, config)],
              }),
            );
            txHash ??= deployHash;
          }
          return txHash;
        });

        store.save(humanHash, { label, wallet, claimedAt: Date.now() });
        return txHash ? { name, txHash } : { name };
      });
    },
  };
}
