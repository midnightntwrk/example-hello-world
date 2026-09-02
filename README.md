# Hello World Example

The repository is intended as part of the tutorial flow for the hello-world example in the [Midnight documentation](https://docs.midnight.network/getting-started/hello-world). It does not operate as a complete repository without the accompanying documentation.

The below documentation will be provided here to "finish" this example.

## Set up project

```bash
git clone git@github.com:midnightntwrk/example-hello-world.git
```

Install dependencies:

```bash
yarn install
```

## Create the contract file

Create a new file named `hello-world.compact` in the `contracts` directory:

```bash
touch contracts/hello-world.compact
```

Open this file in VS Code:
```bash
code .
```

## Create the Compact Smart Contract

```compact
pragma language_version 0.23;

export ledger message: Opaque<"string">;

export circuit storeMessage(newMessage: Opaque<"string">): [] {
  message = disclose(newMessage);
}
```
- `pragma language_version` specifies which version of Compact your contract uses.
- `ledger message` creates a state variable named `message` that stores a string value in the on-chain state. On-chain state is public and persistent on the blockchain.
- `circuit storeMessage` is a Compact circuit (function) that defines the logic to modify on-chain state.
- `newMessage: Opaque<"string">` is the input parameter. *Circuit parameters are always private by default.* The `disclose()` function marks the private value as safe to store publicly. Without it, trying to assign `newMessage` directly to the ledger returns a compiler error.

## Compile the contract

Compiling transforms your Compact code into zero-knowledge circuits, generates cryptographic keys, 
and creates TypeScript APIs and a JavaScript implementation for the contract to be used by DApps. 

Run the compiler from the contracts folder:

```bash
compact compile hello-world.compact managed/hello-world
```

You should see the following output:

```
Compiling 1 circuits:
  circuit "storeMessage" (k=6, rows=26)
```

The compilation process will:
1. Parse and validate your Compact code.
2. Generate zero-knowledge circuits from your logic.
3. Create proving and verifying keys for the circuits.
4. Generate the TypeScript API and JavaScript implementation for the contract.

When compilation completes, you'll see a new directory structure:

```
contracts/
├── managed/
|   └── hello-world/
|        ├── compiler/
|        ├── contract/
|        ├── keys/
|        └── zkir/
└── hello-world.compact
└── index.ts
```

Here's what each directory contains:

- **contract/**: The compiled contract artifacts, which includes the JavaScript implementation and type definitions.
- **keys/**: Cryptographic proving and verifying keys that enable zero-knowledge proofs.
- **zkir/**: Zero-Knowledge Intermediate Representation—the bridge between Compact and the ZK backend.
- **compiler/**: Compiler-generated JSON output that other tools can use to understand the contract structure.

## Deploy Contract to Local Devnet
Now that your contract is compiled, it needs to be deployed to the blockchain so that you can interact with it.

Be sure the Docker engine is running and in a *separate terminal* start the proof server from the project root:
```bash
yarn env:up
```

Leave the proof server running for the following steps.

To deploy the contract, you'll need a wallet. The local devnet package comes with 3 pre-funded wallets.


Run the deployment script:
```bash
yarn test:local
```

The test script will begin to show output from your local devnet and will progress the contract deployment and interaction programatically:

```
[12:46:12.694] INFO (22064): Wallet sync complete after 23 emissions
[12:46:12.703] INFO (22064): Providers initialized. Ready to test
[12:46:12.707] INFO (22064): Creating private state...
[12:46:32.347] INFO (22064): Setting the contract address...
[12:46:32.347] INFO (22064): Contract deployed at: bba6579743ae23b44301d4a9f8df30dbd5244d63a59d8fbc2c9fc7ea521a04f8
 ✓ src/test/hw.test.ts (2 tests) 39112ms
   ✓ Hello World Contract > Deploys the contract  19649ms
   ✓ Hello World Contract > Stores Hello World!   18184ms
```

Stop the Docker container:
```bash
yarn env:down
```

Hello World! You are now ready to explore [Tutorials](https://docs.midnight.network/category/tutorials) for more detailed instructions on building DApps on Midnight!

## Deploy Contract to Live Testnet

A brand-new wallet on Preprod normally takes **~78 minutes** to sync for the first time — almost all of it spent building the chain-wide DUST generation tree. To avoid that, this repo uses **fast-sync**: it seeds each fresh wallet from a pre-computed reference bundle shipped under `preseed/`, so a new wallet is ready in seconds. Fast-sync is the default path for `yarn test:preview` and `yarn test:preprod`; see [`docs/FAST-SYNC.md`](docs/FAST-SYNC.md) for how it works and why it's safe.

> ⚠️ **Fast-sync is for development wallets only.** It is intended for the throwaway testnet wallets this suite generates. Do **not** use it for a mainnet wallet or any wallet holding real funds — a wallet with history must sync from genesis, and seeding it can silently hide funds. See [`docs/FAST-SYNC.md`](docs/FAST-SYNC.md#safety--read-this-before-trusting-it) for the safety rules.

To run the test script on Preview or Preprod:

1. Start the proof server: `yarn proof:up`
1. Start the test: `yarn test:preview` (small reference, quick) or `yarn test:preprod` (the headline network).

The suite drives the rest of the flow for you:

1. It **generates a fresh wallet** and fast-syncs it from the shipped reference. The wallet is cached under `.fast-sync-wallets/<network>.json` (gitignored) and reused on later runs.
1. Because a fresh wallet holds no funds, the suite **prints the wallet's address and the faucet URL, then pauses**. Fund it once with tNIGHT at the faucet — [Preview](https://midnight-tmnight-preview.nethermind.dev/) or [Preprod](https://midnight-tmnight-preprod.nethermind.dev/). The faucet is a human-facing web page (no programmatic drip endpoint). See [Environments and endpoints](https://docs.midnight.network/relnotes/network) for reference.
1. Once the tNIGHT arrives, the suite **resumes automatically**: it registers the NIGHT for DUST generation, waits for spendable tDUST to accrue, then runs the deploy and call tests. You do **not** need to delegate DUST manually.

> **Bring your own wallet (fallback).** If you'd rather use an existing wallet that already has on-chain history, copy `.env.<network>.example` to `.env.<network>` and set either `MIDNIGHT_<NET>_SEED` or `MIDNIGHT_<NET>_MNEMONIC`. That wallet must already be funded with tNIGHT and hold tDUST (delegated in 1AM or Lace Carbon — coming soon). A wallet with history takes a normal full sync rather than fast-sync, since fast-sync can only safely seed a freshly generated wallet. The normal sync will take hours to complete.