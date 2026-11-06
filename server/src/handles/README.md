# Beam handles on ENSv2

Every verified human can claim one **Beam handle** like `kartik.beamfi.eth`. The handle is an ENSv2 subname on Ethereum mainnet, in our own Permissioned Registry, with its own Permissioned Resolver whose roles belong to the user's wallet. Any wallet or agent can then resolve the handle to learn where and how the person wants to be paid (`addr` for Arc's coin type, `beam.network`, `beam.token`).

ENSv2 is central here, not decoration:

- **Enhanced Access Control** is what makes "Beam can't redirect your payments" true. The server key may only create and revoke handles. It never holds a role on any handle's records.
- **Per-name Permissioned Resolvers** (deployed through the Verifiable Factory) are the only way to give each user exclusive record rights: Permissioned Resolver roles are resolver-wide, so a shared resolver would let every writer touch every name.
- **Hierarchical registries**: our registry is the parent name's subregistry, so `kartik.beamfi.eth` is a real ENSv2 token (non-transferable by policy) that the Universal Resolver finds by walking root, `eth`, `beamfi`, `kartik`.
- **World ID** is the Sybil gate: one handle per `humanHash`.

## Verified facts (2026-10-27)

| Fact | Source |
| --- | --- |
| ENSv2 contracts are deployed on mainnet (manifest dated 2026-10-26) and Sepolia (2026-10-01). Addresses in `ensv2.ts`. | [mainnet.md](https://github.com/ensdomains/contracts-v2/blob/4f47cbcc11462fb413196e6b5c0f8090247a6c08/contracts/docs/addresses/mainnet.md), [sepolia.md](https://github.com/ensdomains/contracts-v2/blob/07e55a056f5b6a9c90119f501bdd05714e67dddd/contracts/docs/addresses/sepolia.md), [docs deployments](https://docs.ens.domains/learn/deployments) |
| On mainnet, ENSv1 `.eth` registration is off (both v1 controllers return `controllers() == false` on the BaseRegistrar) and the v2 `ETHRegistrar` holds `ROLE_REGISTRAR` on the v2 `.eth` registry. Existing names are premigrated as RESERVED. | onchain reads; [Migration](https://docs.ens.domains/ensv2/migration) |
| Mainnet resolution: the canonical Universal Resolver (`0xeEeE…EeEe`, the address viem 2.41.2 ships for mainnet and Sepolia) still runs the v1-style implementation, but the v1 `eth` node's resolver is `ENSV2Resolver` (`0x3071…68A4`), a wildcard mirror that walks the ENSv2 registries. So ENSv2 names resolve through viem's default path. On Sepolia the proxy points at `UniversalResolverV2` directly. | onchain reads; [ENSV2Resolver.sol](https://github.com/ensdomains/contracts-v2/blob/4f47cbcc11462fb413196e6b5c0f8090247a6c08/contracts/src/resolver/ENSV2Resolver.sol); [readiness](https://docs.ens.domains/web/ensv2-readiness) (viem >= 2.35.0) |
| `PermissionedRegistry.register(label, owner, registry, resolver, roleBitmap, expiry)` needs `ROLE_REGISTRAR` on root; the owner gets `roleBitmap` on the name. Transfers need `ROLE_CAN_TRANSFER_ADMIN` on the owner. | [PermissionedRegistry.sol](https://github.com/ensdomains/contracts-v2/blob/4f47cbcc11462fb413196e6b5c0f8090247a6c08/contracts/src/registry/PermissionedRegistry.sol), [RegistryRolesLib.sol](https://github.com/ensdomains/contracts-v2/blob/4f47cbcc11462fb413196e6b5c0f8090247a6c08/contracts/src/registry/libraries/RegistryRolesLib.sol), [docs](https://docs.ens.domains/ensv2/permissioned-registry) |
| `PermissionedResolver.initialize(grants, calls)` grants roles on root and runs `calls` as a multicall with role checks skipped. `grantRoles` is disabled; per-argument grants use `grantSetterRoles`. Coin 60 and every EVM coin type fall back to the ENSIP-19 default (`0x80000000`). | [PermissionedResolver.sol](https://github.com/ensdomains/contracts-v2/blob/4f47cbcc11462fb413196e6b5c0f8090247a6c08/contracts/src/resolver/PermissionedResolver.sol), [AbstractRecordResolver.sol](https://github.com/ensdomains/contracts-v2/blob/4f47cbcc11462fb413196e6b5c0f8090247a6c08/contracts/src/resolver/AbstractRecordResolver.sol), [docs](https://docs.ens.domains/ensv2/permissioned-resolver) |
| `VerifiableFactory.deployProxy(impl, salt, data)` deploys at `CREATE2(keccak256(abi.encode(msg.sender, salt)))`; `predictProxyAddress(deployer, salt)` is onchain. | [VerifiableFactory.sol](https://github.com/ensdomains/verifiable-factory/blob/main/src/VerifiableFactory.sol), [docs](https://docs.ens.domains/ensv2/verifiable-factory) |
| Subname registries: deploy a `UserRegistry` proxy, `setSubregistry` on the parent, grant a registrar `ROLE_REGISTRAR`. | [Subnames](https://docs.ens.domains/ensv2/subnames), [For Contract Developers](https://docs.ens.domains/ensv2/tutorial-contract-developers) |

Every ABI fragment in `ensv2.ts` was checked against the deployment artifacts (`contracts/deployments/{mainnet,sepolia}/*.json`) at the pinned commits. No npm ABI package is used.

The whole flow (setup script, claim through these routes, resolution through viem's default Universal Resolver, and every role check below) was run end to end on an anvil fork of mainnet.

## Design

```
.eth registry (ENSv2)          beamfi.eth  owner: parent owner (cold key)
  └─ subregistry ───────────▶  Beam UserRegistry (PermissionedRegistry proxy)
        root roles: registrar key  REGISTRAR | UNREGISTER
                    parent owner   REGISTRAR_ADMIN | UNREGISTER_ADMIN | SET_PARENT
        kartik  owner: user wallet, roles SET_RESOLVER (+admin), no CAN_TRANSFER_ADMIN, no expiry
          └─ resolver ──────▶  PermissionedResolver proxy (one per handle)
                                 root roles: user wallet ALL_ROLES; registrar: none
                                 addr(Arc coin type) = addr(default) = wallet
                                 text beam.network = arc, beam.token = USDC, url = repo
```

A claim (`registrar.ts`) is two transactions from the registrar key:

1. `register(label, wallet, 0x0, predictedResolver, SET_RESOLVER | SET_RESOLVER_ADMIN, 2^64 - 1)` on our registry. This claims the label before any gas goes into the resolver.
2. `VerifiableFactory.deployProxy(PermissionedResolverImpl, salt, initialize([{ wallet, ALL_ROLES }], [setAddress ×2, setText ×3]))`. The initial records are written inside `initialize`, where ENSv2 skips role checks, so the registrar writes them without ever holding a resolver role. The salt mixes in `namehash(name)` and the wallet, so a resolver is never reused for another owner.

Both steps are resumable: a retry skips a name already registered to the same wallet and a resolver already deployed at its predicted address. A second claim by the same human returns the stored name without a transaction.

### Trust model (stated plainly)

| Actor | Can | Cannot |
| --- | --- | --- |
| Registrar key (server) | create handles; revoke (`unregister`) a handle for abuse | change any record, change a handle's resolver, upgrade anything, transfer tokens |
| Parent owner (cold key) | rotate the registrar key; replace the whole subregistry of `beamfi.eth` (it owns the parent) | edit a user's records |
| User wallet | every record on its resolver, point the handle at another resolver, delegate per-key roles | transfer the handle |

Revocation is visible onchain (`LabelUnregistered`). A revoked human stays recorded in the store, so they cannot claim again.

## Endpoints

Mounted at `/v1/handles` behind auth and rate limiting (`routes.ts`):

- `GET /:label` → `HandleAvailability`. Invalid or reserved labels return `available: false` with the rule as `reason` (no chain call).
- `GET /?wallet=0x…` → `HandleLookup`, only while the wallet still owns the name onchain.
- `POST /` `{ label, wallet, approvalId }` → `HandleClaim`. Label errors return 400 `HANDLE_INVALID` before the approval is consumed; no approval → 403 `NOT_LINKED` (thrown approval errors with a `code` map to 404/410/409/403); taken → 409 `HANDLE_TAKEN`; RPC or tx failure → 502 `HANDLE_CHAIN_ERROR` with a fixed message.
- Not configured → 503 `HANDLES_NOT_CONFIGURED`.

Claims are serialized in process and wait for both receipts (about two blocks on mainnet, so 25 to 40 s).

## Setup

### 1. Choose and register the parent on ENSv2

On mainnet, new `.eth` names are registered only through the ENSv2 `ETHRegistrar` (commit-reveal, paid in a stablecoin) via the ENS app. An existing ENSv1 name must first be migrated (transfer to `UnlockedMigrationController`), see [Migration](https://docs.ens.domains/ensv2/migration).

Pick a parent with **no stale ENSv1 registry entry**. The mainnet Universal Resolver still consults the v1 registry first, so a leftover v1 resolver hides the whole ENSv2 subtree. `beamfi.eth` is clean in both v1 and v2 (no stale resolver). Check a candidate:

```sh
cast call 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e 'resolver(bytes32)(address)' $(cast namehash beamfi.eth) --rpc-url $ENS_RPC_URL   # want 0x000…0
cast call 0xf60aba43e1f7f3dab1186ff03b561401c9df85e2 'getStatus(uint256)(uint8)' $(cast keccak beamfi) --rpc-url $ENS_RPC_URL     # 0 = available
```

### 2. Run the setup script (Sepolia first, then mainnet)

Use two keys: the **parent owner** (the account that registered the parent) and a fresh **registrar** key for the server.

```sh
cd server
ENS_CHAIN=sepolia ENS_RPC_URL=https://… ENS_PARENT_NAME=beamfi.eth \
ENS_OWNER_PRIVATE_KEY=0x… ENS_REGISTRAR_ADDRESS=0x… \
npx tsx scripts/ens-setup.ts              # dry run: checks the parent, prints the planned transactions
npx tsx scripts/ens-setup.ts --broadcast  # sends them, verifies the registrar's roles, prints the .env lines
```

On Sepolia, register the parent at sepolia.app.ens.domains (it accepts the freely mintable test USDC). Then repeat with `ENS_CHAIN=mainnet`.

### 3. Server env

```sh
ENS_CHAIN=mainnet                 # or sepolia
ENS_RPC_URL=https://…             # used by the server's ENS client; claims send through it too
ENS_PARENT_NAME=beamfi.eth
ENS_REGISTRAR_PRIVATE_KEY=0x…     # create/revoke only; fund with a little ETH
ENS_HANDLE_REGISTRY=0x…           # printed by ens-setup
BEAM_REPO_URL=https://github.com/… # written to each handle's url record
# optional: HANDLES_STORE_PATH (default data/handles.json), ENS_VERIFIABLE_FACTORY, ENS_RESOLVER_IMPL
```

### Gas budget (measured on a mainnet fork)

| Step | Gas |
| --- | --- |
| Setup: deploy registry 228k, setParent 81k, setSubregistry 58k | ~367k once |
| Claim: register 173k + resolver deploy with 5 records 436k | ~609k per handle |

At 0.1 gwei a handle costs about 0.00006 ETH; at 2 gwei about 0.0012 ETH; at 10 gwei about 0.006 ETH. 0.05 ETH covers the event with a wide margin. The parent registration fee is separate.

## How to resolve a handle (judges)

```ts
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { toCoinType } from 'viem/ens';

const client = createPublicClient({ chain: mainnet, transport: http() });
const name = 'kartik.beamfi.eth';
await client.getEnsAddress({ name, coinType: toCoinType(5042002) }); // Arc address
await client.getEnsAddress({ name });                                // default EVM address
await client.getEnsText({ name, key: 'beam.network' });               // "arc"
```

To inspect the roles: `getResolver("kartik")` on `ENS_HANDLE_REGISTRY` gives the handle's resolver; on it, `roles(0, <registrar>)` is `0` and `hasRootRoles(ALL_ROLES, <wallet>)` is `true`. On the registry, `hasRootRoles(1 | 1<<12, <registrar>)` is `true` and `hasRootRoles(1<<24, <registrar>)` is `false`.
