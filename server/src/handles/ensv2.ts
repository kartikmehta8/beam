/**
 * @file The slice of ENSv2 that Beam handles use: deployed addresses, role
 * bits and ABIs. Everything here is copied from the verified sources below;
 * nothing is invented. Re-check them when ENS publishes a new deployment.
 *
 * Addresses: ENS docs deployments table, generated from
 * https://github.com/ensdomains/contracts-v2/blob/4f47cbcc11462fb413196e6b5c0f8090247a6c08/contracts/docs/addresses/mainnet.md
 * https://github.com/ensdomains/contracts-v2/blob/07e55a056f5b6a9c90119f501bdd05714e67dddd/contracts/docs/addresses/sepolia.md
 * ABIs: the deployment artifacts in `contracts/deployments/<chain>/*.json` at the same commits.
 */
import { parseAbi, type Address } from 'viem';

/** Chains with an ENSv2 deployment. */
export type EnsChainKey = 'mainnet' | 'sepolia';

/** ENSv2 protocol contracts Beam needs. */
export type Ensv2Deployment = {
  /** `.eth` PermissionedRegistry: holds the parent name (e.g. beamfi.eth). */
  ethRegistry: Address;
  /** Deploys UUPS proxies at deterministic CREATE2 addresses. */
  verifiableFactory: Address;
  /** Implementation behind each per-handle Permissioned Resolver proxy. */
  permissionedResolverImpl: Address;
  /** Implementation behind our subname registry proxy (a PermissionedRegistry). */
  userRegistryImpl: Address;
};

export const ENSV2_DEPLOYMENTS: Record<EnsChainKey, Ensv2Deployment> = {
  mainnet: {
    ethRegistry: '0xf60aba43e1f7f3dab1186ff03b561401c9df85e2',
    verifiableFactory: '0x77510ba162dfea3d8989e3f0928a691b345730d2',
    permissionedResolverImpl: '0x565b0f456a04ac9b48758190e90030623cff57c5',
    userRegistryImpl: '0xfaa23592aca10a6d8875b18ea86954e8eb6d8d72',
  },
  sepolia: {
    ethRegistry: '0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4',
    verifiableFactory: '0xda70306c98e97ece36f997a21368e53298572991',
    permissionedResolverImpl: '0x115eb53f0c60696633855f90b138178fb40b2b2c',
    userRegistryImpl: '0x9bd8a88719068d09ecee662f36c0e3856708366a',
  },
};

/**
 * PermissionedRegistry roles (contracts/src/registry/libraries/RegistryRolesLib.sol).
 * Each role has an admin twin at `role << 128`, except CAN_TRANSFER_ADMIN which is admin-only.
 */
export const REGISTRY_ROLES = {
  REGISTRAR: 1n << 0n,
  SET_PARENT: 1n << 8n,
  UNREGISTER: 1n << 12n,
  SET_SUBREGISTRY: 1n << 20n,
  SET_RESOLVER: 1n << 24n,
  CAN_TRANSFER_ADMIN: (1n << 28n) << 128n,
} as const;

/** Admin twin of a role: the right to grant and revoke it. */
export const admin = (role: bigint): bigint => role << 128n;

/**
 * Every EAC role and its admin (EACBaseRolesLib.ALL_ROLES). Granted to the user on
 * their own Permissioned Resolver: they own all records, upgrades included.
 */
export const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n;

/** PermissionedRegistry status enum (IPermissionedRegistry.Status). */
export const STATUS = { AVAILABLE: 0, RESERVED: 1, REGISTERED: 2 } as const;

/** ENSIP-19 default EVM coin type: used by every EVM chain (and coin 60) without its own record. */
export const COIN_TYPE_DEFAULT = 0x80000000n;

/** Registry entries that never expire (handles are revocable, not rented). */
export const NO_EXPIRY = 2n ** 64n - 1n;

/** contracts/src/registry/UserRegistry.sol + interfaces/IPermissionedRegistry.sol, IStandardRegistry.sol. */
export const permissionedRegistryAbi = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
  'function unregister(uint256 anyId)',
  'function getStatus(uint256 anyId) view returns (uint8)',
  'function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource) state)',
  'function getOwner(uint256 anyId) view returns (address)',
  'function getSubregistry(string label) view returns (address)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setParent(address parent, string label)',
  'function getParent() view returns (address parent, string label)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function roles(uint256 anyId, address account) view returns (uint256)',
]);

/** contracts/src/resolver/PermissionedResolver.sol (+ IPermissionedResolverInitializable, setters). */
export const permissionedResolverAbi = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)',
  'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
  'function setText(bytes name, string key, string value)',
]);

/** https://github.com/ensdomains/verifiable-factory/blob/main/src/VerifiableFactory.sol */
export const verifiableFactoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)',
  'function predictProxyAddress(address deployer, uint256 salt) view returns (address proxy)',
  'event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)',
]);
