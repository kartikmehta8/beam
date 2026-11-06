/**
 * @file One-time ENSv2 setup for Beam handles under a parent name (e.g. beamfi.eth).
 *
 * 1. Checks the parent is REGISTERED in the ENSv2 `.eth` registry and owned by the owner key.
 * 2. Deploys our subname registry: a UserRegistry proxy (a PermissionedRegistry) via the
 *    VerifiableFactory, initialized with the parent owner's admin roles and the registrar
 *    key's create/revoke roles (REGISTRAR | UNREGISTER, nothing else).
 * 3. Sets the registry's canonical parent and points the parent name's subregistry at it.
 * 4. Verifies the roles and prints the lines to paste into `.env`.
 * Every step is skipped when already done, so it can be re-run safely.
 *
 * Usage (from server/): `npx tsx scripts/ens-setup.ts` (dry run) or `npx tsx scripts/ens-setup.ts --broadcast`.
 * Env: ENS_RPC_URL, ENS_CHAIN (mainnet|sepolia), ENS_PARENT_NAME, ENS_OWNER_PRIVATE_KEY (parent owner;
 * ENS_OWNER_ADDRESS is enough for a dry run), ENS_REGISTRAR_PRIVATE_KEY or ENS_REGISTRAR_ADDRESS.
 */
import { existsSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { labelhash, namehash } from 'viem/ens';
import { getEnsChain, parseParentName } from '../src/handles/config';
import { ENSV2_DEPLOYMENTS, permissionedRegistryAbi, REGISTRY_ROLES, STATUS, verifiableFactoryAbi } from '../src/handles/ensv2';
import { PARENT_OWNER_ROOT_ROLES, REGISTRAR_ROOT_ROLES } from '../src/handles/registrar';

/** Bump to deploy a fresh registry at a new address. */
const REGISTRY_VERSION = 0n;

/**
 * Exits with a message.
 * @param message What went wrong and what to do.
 * @returns Never.
 */
function die(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/**
 * Reads a required env var.
 * @param name Variable name.
 * @returns Trimmed value.
 */
function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) die(`Set ${name}.`);
  return value;
}

/**
 * Account from an optional private key env var.
 * @param name Variable name.
 * @returns Account, or null when unset.
 */
function keyAccount(name: string): PrivateKeyAccount | null {
  const key = process.env[name]?.trim();
  if (!key) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die(`${name} must be a 0x-prefixed 32-byte hex key.`);
  return privateKeyToAccount(key as Hex);
}

/**
 * Address from a key var or a plain address var.
 * @param keyVar Private key variable.
 * @param addressVar Address variable.
 * @returns Account (when a key is set) and address.
 */
function who(keyVar: string, addressVar: string): { account: PrivateKeyAccount | null; address: Address } {
  const account = keyAccount(keyVar);
  if (account) return { account, address: account.address };
  const raw = process.env[addressVar]?.trim();
  if (!raw) die(`Set ${keyVar} (or ${addressVar} for a dry run).`);
  return { account: null, address: getAddress(raw) };
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const broadcast = process.argv.includes('--broadcast');
  const { key: chainKey, chain } = getEnsChain(process.env.ENS_CHAIN);
  const contracts = ENSV2_DEPLOYMENTS[chainKey];
  const parentName = parseParentName(need('ENS_PARENT_NAME'));
  const parentLabel = parentName.slice(0, -'.eth'.length);
  const parentId = BigInt(labelhash(parentLabel));
  const owner = who('ENS_OWNER_PRIVATE_KEY', 'ENS_OWNER_ADDRESS');
  const registrar = who('ENS_REGISTRAR_PRIVATE_KEY', 'ENS_REGISTRAR_ADDRESS').address;
  if (isAddressEqual(owner.address, registrar)) die('Use different keys for the parent owner and the registrar (least privilege).');
  if (broadcast && !owner.account) die('--broadcast needs ENS_OWNER_PRIVATE_KEY.');

  const client = createPublicClient({ chain, transport: http(need('ENS_RPC_URL')) });
  const wallet = owner.account ? createWalletClient({ account: owner.account, chain, transport: http(need('ENS_RPC_URL')) }) : null;
  console.log(`ENSv2 handle setup on ${chain.name} for ${parentName}${broadcast ? '' : ' (dry run, add --broadcast to send)'}`);
  console.log(`  parent owner ${owner.address}\n  registrar    ${registrar}`);

  /** Sends one transaction (or prints it in a dry run) and waits for success. */
  const step = async (what: string, to: Address, data: Hex): Promise<void> => {
    if (!wallet) {
      console.log(`  would send: ${what}\n    to ${to}\n    data ${data.slice(0, 74)}…`);
      return;
    }
    const hash = await wallet.sendTransaction({ to, data });
    console.log(`  ${what}: ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') die(`${what} reverted (${hash}).`);
    console.log(`    gas used ${receipt.gasUsed}`);
  };

  // 1. The parent must be an ENSv2 name we own, with the right to set its subregistry.
  const parent = await client.readContract({ address: contracts.ethRegistry, abi: permissionedRegistryAbi, functionName: 'getState', args: [parentId] });
  if (parent.status !== STATUS.REGISTERED) {
    die(
      `${parentName} is not registered in the ENSv2 .eth registry (status ${parent.status}). ` +
        'Register it on the ENS app, or migrate an ENSv1 name through the UnlockedMigrationController (see README).',
    );
  }
  if (!isAddressEqual(parent.latestOwner, owner.address)) die(`${parentName} is owned by ${parent.latestOwner}, not the owner key.`);
  const parentRoles = await client.readContract({ address: contracts.ethRegistry, abi: permissionedRegistryAbi, functionName: 'roles', args: [parentId, owner.address] });
  if ((parentRoles & REGISTRY_ROLES.SET_SUBREGISTRY) === 0n) die(`The owner key lacks SET_SUBREGISTRY on ${parentName}.`);
  console.log(`✓ ${parentName} is registered on ENSv2 and owned by the owner key`);

  // 2. Our subname registry, at a deterministic address (salt scheme from the ENS docs).
  const salt = BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
        [keccak256(stringToHex('UserRegistry')), namehash(parentName), REGISTRY_VERSION],
      ),
    ),
  );
  const registry = await client.readContract({
    address: contracts.verifiableFactory,
    abi: verifiableFactoryAbi,
    functionName: 'predictProxyAddress',
    args: [owner.address, salt],
  });
  const deployed = !!(await client.getCode({ address: registry }));
  if (deployed) console.log(`✓ registry already deployed at ${registry}`);
  else {
    const init = encodeFunctionData({
      abi: permissionedRegistryAbi,
      functionName: 'initialize',
      args: [[{ account: owner.address, roleBitmap: PARENT_OWNER_ROOT_ROLES }, { account: registrar, roleBitmap: REGISTRAR_ROOT_ROLES }]],
    });
    await step(
      `deploy UserRegistry ${registry}`,
      contracts.verifiableFactory,
      encodeFunctionData({ abi: verifiableFactoryAbi, functionName: 'deployProxy', args: [contracts.userRegistryImpl, salt, init] }),
    );
  }

  // 3. Canonical parent (lets explorers print full names), then link the parent name to the registry.
  const [currentParent] = deployed
    ? await client.readContract({ address: registry, abi: permissionedRegistryAbi, functionName: 'getParent' })
    : [null];
  if (currentParent && isAddressEqual(currentParent, contracts.ethRegistry)) console.log('✓ registry parent already set');
  else {
    await step(
      `setParent(.eth registry, "${parentLabel}")`,
      registry,
      encodeFunctionData({ abi: permissionedRegistryAbi, functionName: 'setParent', args: [contracts.ethRegistry, parentLabel] }),
    );
  }
  const currentSub = await client.readContract({ address: contracts.ethRegistry, abi: permissionedRegistryAbi, functionName: 'getSubregistry', args: [parentLabel] });
  if (isAddressEqual(currentSub, registry)) console.log(`✓ ${parentName} already points at the registry`);
  else {
    await step(
      `setSubregistry(${parentName} → registry)`,
      contracts.ethRegistry,
      encodeFunctionData({ abi: permissionedRegistryAbi, functionName: 'setSubregistry', args: [parentId, registry] }),
    );
  }

  // 4. Verify least privilege, then print the env.
  if (wallet) {
    const has = (roles: bigint, account: Address) =>
      client.readContract({ address: registry, abi: permissionedRegistryAbi, functionName: 'hasRootRoles', args: [roles, account] });
    if (!(await has(REGISTRAR_ROOT_ROLES, registrar))) die('Registrar is missing REGISTRAR | UNREGISTER on the registry.');
    for (const [name, role] of [['SET_RESOLVER', REGISTRY_ROLES.SET_RESOLVER], ['SET_SUBREGISTRY', REGISTRY_ROLES.SET_SUBREGISTRY]] as const) {
      if (await has(role, registrar)) die(`Registrar unexpectedly holds ${name}.`);
    }
    console.log('✓ registrar can create and revoke handles, and nothing else');
  }
  console.log(`\nPaste into server/.env:\nENS_CHAIN=${chainKey}\nENS_PARENT_NAME=${parentName}\nENS_HANDLE_REGISTRY=${registry}`);
}

main().catch((err: unknown) => die(err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err)));
