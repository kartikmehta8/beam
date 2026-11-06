# Beam website

A Beam adaptation of the Orb landing page, using the same layout and interaction components.

```sh
npm ci
npm run verify
npm run dev
```

Open http://127.0.0.1:18789/. The static build goes to `dist/`. For Vercel, use `website` as the root directory. The included configuration runs `npm run verify` and serves `dist/`. Set `SITE_URL` to the final origin if needed.

All demonstrations use fixed examples. The hero player is a guided browser walkthrough. The Android page links to Beam’s build instructions. A future Beam film or APK can be added when the corresponding asset is available.

The network picker uses illustrative testnets. Chain IDs are sourced from the [Ethereum Sepolia documentation](https://geth.ethereum.org/docs/getting-started) and [Base Sepolia documentation](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_chainId).
