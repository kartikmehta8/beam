/**
 * @file Env parsing for Beam handles. Handles are off (null config) until the
 * parent name, registrar key and registry address are all set; a partial or
 * malformed setup throws so a typo fails at startup, not on the first claim.
 */
import { getAddress, isAddress, type Address, type Chain, type Hex } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { normalize } from 'viem/ens';
import { getNetwork, type Network } from '../network';
import { ENSV2_DEPLOYMENTS, type EnsChainKey, type Ensv2Deployment } from './ensv2';

/** Written to each handle's `url` text record until BEAM_REPO_URL is set. */
export const REPO_URL_PLACEHOLDER = 'https://github.com/REPLACE_ME/beam';
const DEFAULT_STORE_PATH = 'data/handles.json';

/** Everything the handle registrar needs. */
export type HandlesConfig = {
  chainKey: EnsChainKey;
  /** viem chain for ENS (Ethereum mainnet or Sepolia). */
  chain: Chain;
  /** Normalized parent, e.g. "beamfi.eth". */
  parentName: string;
  /** Server key: may only create and revoke handles in `registry`. */
  registrarKey: Hex;
  /** Our subname registry (a UserRegistry proxy set as the parent's subregistry). */
  registry: Address;
  contracts: Ensv2Deployment;
  /** Payment network whose coin type and token go into each handle's records. */
  network: Network;
  repoUrl: string;
  /** JSON file mapping humanHash to handle. */
  storePath: string;
};

type Env = Record<string, string | undefined>;

/**
 * Resolves the ENS chain from `ENS_CHAIN`.
 * @param value "mainnet" (default) or "sepolia".
 * @returns Chain key and viem chain; build the ENS PublicClient with this chain.
 * @throws Error on any other value.
 */
export function getEnsChain(value: string | undefined): { key: EnsChainKey; chain: Chain } {
  const key = (value ?? '').trim().toLowerCase() || 'mainnet';
  if (key === 'mainnet') return { key, chain: mainnet };
  if (key === 'sepolia') return { key, chain: sepolia };
  throw new Error(`Unsupported ENS_CHAIN "${value}". Use "mainnet" or "sepolia".`);
}

/**
 * Reads an optional address override.
 * @param env Environment.
 * @param name Variable name.
 * @param fallback Default from the official deployment.
 * @returns Checksummed address.
 */
function addressEnv(env: Env, name: string, fallback: Address): Address {
  const raw = env[name]?.trim() || fallback;
  if (!isAddress(raw, { strict: false })) throw new Error(`${name} is not an address.`);
  return getAddress(raw);
}

/**
 * Normalizes a parent name and requires a `.eth` second-level name (what ENSv2's ETH registry holds).
 * @param raw e.g. "BeamFi.eth".
 * @returns e.g. "beamfi.eth".
 */
export function parseParentName(raw: string): string {
  let name: string;
  try {
    name = normalize(raw.trim());
  } catch {
    throw new Error(`ENS_PARENT_NAME "${raw}" is not a valid ENS name.`);
  }
  if (!/^[^.]+\.eth$/.test(name)) throw new Error('ENS_PARENT_NAME must be a .eth name like beamfi.eth.');
  return name;
}

/**
 * Loads handle config from env.
 * Required together: ENS_PARENT_NAME, ENS_REGISTRAR_PRIVATE_KEY, ENS_HANDLE_REGISTRY.
 * Optional: ENS_CHAIN, ENS_VERIFIABLE_FACTORY, ENS_RESOLVER_IMPL, BEAM_NETWORK, BEAM_REPO_URL, HANDLES_STORE_PATH.
 * @param env Usually `process.env`.
 * @returns Config, or null when handles are not configured at all.
 * @throws Error when only some required values are set or a value is malformed.
 */
export function loadHandlesConfig(env: Env): HandlesConfig | null {
  const required = ['ENS_PARENT_NAME', 'ENS_REGISTRAR_PRIVATE_KEY', 'ENS_HANDLE_REGISTRY'] as const;
  const missing = required.filter((k) => !env[k]?.trim());
  if (missing.length === required.length) return null;
  if (missing.length) throw new Error(`Handles are half configured: set ${missing.join(', ')}.`);

  const { key: chainKey, chain } = getEnsChain(env.ENS_CHAIN);
  const defaults = ENSV2_DEPLOYMENTS[chainKey];
  const registrarKey = env.ENS_REGISTRAR_PRIVATE_KEY!.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(registrarKey)) throw new Error('ENS_REGISTRAR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key.');
  const repoUrl = env.BEAM_REPO_URL?.trim() || REPO_URL_PLACEHOLDER;
  if (!/^https:\/\/\S+$/.test(repoUrl)) throw new Error('BEAM_REPO_URL must be an https URL.');

  return {
    chainKey,
    chain,
    parentName: parseParentName(env.ENS_PARENT_NAME!),
    registrarKey: registrarKey as Hex,
    registry: addressEnv(env, 'ENS_HANDLE_REGISTRY', '0x'),
    contracts: {
      ...defaults,
      verifiableFactory: addressEnv(env, 'ENS_VERIFIABLE_FACTORY', defaults.verifiableFactory),
      permissionedResolverImpl: addressEnv(env, 'ENS_RESOLVER_IMPL', defaults.permissionedResolverImpl),
    },
    network: getNetwork(env.BEAM_NETWORK),
    repoUrl,
    storePath: env.HANDLES_STORE_PATH?.trim() || DEFAULT_STORE_PATH,
  };
}
