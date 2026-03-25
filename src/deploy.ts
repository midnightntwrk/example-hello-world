// This file is part of example-hello-world.
// Copyright (C) 2025-2026 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//	https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';

// Midnight.js imports
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';

// Shared utilities from the utils.ts file
import { 
  createWallet, 
  createProviders, 
  compiledContract, 
  zkConfigPath,
} from './utils.js';
import { ensureCompiledArtifacts } from './check-artifacts.js';

// ─── Main Deploy Script ────────────────────────────────────────────────────────

async function main() {
  ensureCompiledArtifacts();

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║        Deploy Hello World to Midnight Preprod                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Check if contract is compiled
  if (!fs.existsSync(path.join(zkConfigPath, 'contract', 'index.js'))) {
    console.error('Contract not compiled! Run: npm run compile');
    process.exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    // 1. Wallet setup
    console.log('─── Step 1: Wallet Setup ───────────────────────────────────────\n');
    const choice = await rl.question(
      '  [1] Create new wallet\n  [2] Restore from seed\n  > '
    );

    const seed = choice.trim() === '2'
      ? await rl.question('\n  Enter your 64-character seed: ')
      : toHex(Buffer.from(generateRandomSeed()));

    if (choice.trim() !== '2') {
      console.log(
        `\n  ⚠️  SAVE THIS SEED (you'll need it later):\n  ${seed}\n`
      );
    }

    console.log('  Creating wallet...');
    const walletCtx = await createWallet(seed);

    console.log('  Syncing with network...');
    const state = await walletCtx.wallet.waitForSyncedState();
    
    const address = walletCtx.unshieldedKeystore.getBech32Address();
    const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;

    console.log(`\n  Wallet Address: ${address}`);
    console.log(`  Balance: ${balance.toLocaleString()} tNight\n`);

        // 2. Fund wallet if needed
    if (balance === 0n) {
      console.log('─── Step 2: Fund Your Wallet ───────────────────────────────────\n');
      console.log('  Visit: https://faucet.preprod.midnight.network/');
      console.log(`  Address: ${address}\n`);
      console.log('  Waiting for funds...');

      await Rx.firstValueFrom(
        walletCtx.wallet.state().pipe(
          Rx.throttleTime(10000),
          Rx.filter((s) => s.isSynced),
          Rx.map((s) => s.unshielded.balances[unshieldedToken().raw] ?? 0n),
          Rx.filter((b) => b > 0n),
        ),
      );
      console.log('  Funds received!\n');
    }

    // 3. Register for DUST
    console.log('─── Step 3: DUST Token Setup ───────────────────────────────────\n');
    const dustState = await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced))
    );

    if (dustState.dust.balance(new Date()) === 0n) {
      const nightUtxos = dustState.unshielded.availableCoins.filter(
        (c) => !c.meta?.registeredForDustGeneration
      );
      
      if (nightUtxos.length > 0) {
        console.log('  Registering for DUST generation...');
        const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
          nightUtxos,
          walletCtx.unshieldedKeystore.getPublicKey(),
          (payload) => walletCtx.unshieldedKeystore.signData(payload),
        );
        const signedRecipe = await walletCtx.wallet.signRecipe(recipe, (payload) =>
          walletCtx.unshieldedKeystore.signData(payload),
        );
        await walletCtx.wallet.submitTransaction(
          await walletCtx.wallet.finalizeRecipe(signedRecipe)
        );
      }

      console.log('  Waiting for DUST tokens...');
      await Rx.firstValueFrom(
        walletCtx.wallet.state().pipe(
          Rx.throttleTime(5000),
          Rx.filter((s) => s.isSynced),
          Rx.filter((s) => s.dust.balance(new Date()) > 0n)
        ),
      );
    }
    console.log('  DUST tokens ready!\n');

        // 4. Deploy contract
    console.log('─── Step 4: Deploy Contract ────────────────────────────────────\n');
    console.log('  Setting up providers...');
    const providers = await createProviders(walletCtx);

    console.log('  Deploying contract (this may take 30-60 seconds)...\n');
    const deployed = await deployContract(providers, {
      compiledContract,
      args: [],
    });

    const contractAddress = deployed.deployTxData.public.contractAddress;
    console.log('  ✅ Contract deployed successfully!\n');
    console.log(`  Contract Address: ${contractAddress}\n`);

    // 5. Save deployment info
    const deploymentInfo = {
      contractAddress,
      seed,
      network: 'preprod',
      deployedAt: new Date().toISOString(),
    };

    fs.writeFileSync('deployment.json', JSON.stringify(deploymentInfo, null, 2));
    console.log('  Saved to deployment.json\n');

    await walletCtx.wallet.stop();
    console.log('─── Deployment Complete! ───────────────────────────────────────\n');
  } finally {
    rl.close();
  }
}

main().catch(console.error);
