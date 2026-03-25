# Hello World Example

This repository tracks the official Midnight `hello-world` flow, updated for the Midnight 2026 compatibility matrix.

Source of truth for supported versions:

- Compatibility matrix: https://docs.midnight.network/relnotes/support-matrix
- Official tutorial flow: https://docs.midnight.network/getting-started/hello-world

This repo intentionally uses the compatibility matrix as the baseline when it differs from older getting-started pages.

## Supported baseline

- Node.js `v22+`
- `compact` `0.5.0`
- `compact compile` / `compactc` `0.30.0`
- Midnight.js `4.0.2`
- Wallet SDK Facade `3.0.0`
- Ledger / Proof Server `8.0.3`

## Important note about the proof server

As of March 24, 2026, the compatibility matrix lists Proof Server `8.0.3` as the latest tested version.

Some older Midnight docs pages still show `midnightntwrk/proof-server:7.0.0`. This repository follows the compatibility matrix and uses `8.0.3`.

## Project layout

- `contracts/hello-world.compact`: source contract committed to the repo
- `contracts/managed/hello-world/`: generated build output from `compact compile`
- `src/deploy.ts`: deploy script for Preprod
- `src/cli.ts`: interactive CLI for reading and writing the contract state

Generated artifacts under `contracts/managed/` are not committed.

## Setup

Install dependencies:

```bash
npm install
```

Verify the local toolchain:

```bash
node -v
compact --version
compact compile --version
```

## Compile the contract

Compile the Compact contract first:

```bash
npm run compile
```

This generates:

```text
contracts/managed/hello-world/
├── compiler/
├── contract/
├── keys/
└── zkir/
```

The TypeScript app expects these generated artifacts to exist. If they are missing, `build`, `deploy`, and `cli` will fail with an explicit message telling you to run `npm run compile`.

## Build the TypeScript app

```bash
npm run build
```

## Start the proof server

Run the local proof server in a separate terminal:

```bash
npm run start-proof-server
```

This uses:

```bash
docker run -p 6300:6300 midnightntwrk/proof-server:8.0.3 -- midnight-proof-server -v
```

Leave it running while deploying and interacting with the contract.

## Deploy to Preprod

Run:

```bash
export PRIVATE_STATE_PASSWORD='Str0ng!MidnightLocal'
npm run deploy
```

The script will:

1. Create a new wallet or restore one from seed.
2. Wait for tNIGHT funding if needed.
3. Register available NIGHT UTxOs for DUST generation if needed.
4. Wait for DUST to become usable.
5. Deploy the contract to Midnight Preprod.
6. Save deployment metadata to `deployment.json`.

If the wallet is unfunded, the script prints the faucet-ready address and waits for funds.

## Interact with the contract

After deployment:

```bash
export PRIVATE_STATE_PASSWORD='Str0ng!MidnightLocal'
npm run cli
```

The CLI can:

- Store a message on-chain
- Read the current public ledger message

## Typical flow

```bash
npm install
npm run compile
npm run build
npm run start-proof-server
export PRIVATE_STATE_PASSWORD='Str0ng!MidnightLocal'
npm run deploy
npm run cli
```

## Why this repo asks for `PRIVATE_STATE_PASSWORD`

The official Midnight `hello-world` docs describe the contract and deployment flow at a high level, but they do not go into the configuration details of the local private state provider used by this repository.

This repo uses the official encrypted LevelDB provider:

- `@midnight-ntwrk/midnight-js-level-private-state-provider`

That provider stores local contract private state and signing keys, and it requires:

- `privateStoragePasswordProvider`
- a strong password
- an `accountId`

This is why this repo asks for `PRIVATE_STATE_PASSWORD` even though the high-level tutorial does not mention it.

Important:

- your wallet seed and `PRIVATE_STATE_PASSWORD` are different secrets
- the seed is for wallet key derivation
- `PRIVATE_STATE_PASSWORD` is only for encrypting local provider storage
- reuse the same `PRIVATE_STATE_PASSWORD` in future `deploy` and `cli` runs if you want to reopen the same local encrypted storage

You can also pass it inline per command:

```bash
PRIVATE_STATE_PASSWORD='Str0ng!MidnightLocal' npm run deploy
PRIVATE_STATE_PASSWORD='Str0ng!MidnightLocal' npm run cli
```

## Troubleshooting

Missing compiled artifacts:

```text
Missing compiled contract artifacts. Run `npm run compile` before `npm run build`, `npm run deploy`, or `npm run cli`.
```

Proof server not running:

- Make sure Docker Desktop is running.
- Make sure port `6300` is available.
- If you change the port, update `CONFIG.proofServer` in [src/utils.ts](/Users/jmaciaal/Projects/example-hello-world/src/utils.ts).

Build issues:

- Confirm you are on Node `v22+`
- Confirm `compact --version` is `0.5.0`
- Confirm `compact compile --version` is `0.30.0`

Missing local encryption password:

```text
Missing PRIVATE_STATE_PASSWORD. This repo uses the official encrypted Level private state provider...
```

Set a strong password before running `deploy` or `cli`:

```bash
export PRIVATE_STATE_PASSWORD='Str0ng!MidnightLocal'
```
