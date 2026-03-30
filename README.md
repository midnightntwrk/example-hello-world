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
pragma language_version >= 0.22;

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
   ✓ Hello World Contract > Stores a message  18184ms
```

Hello World! You are now ready to explore [Tutorials](https://docs.midnight.network/category/tutorials) for more detailed instructions on building DApps on Midnight!