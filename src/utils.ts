// This file is part of example-hello-world.
// Copyright (C) 2025-2026 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';

import type { Contract as CompactContract } from '@midnight-ntwrk/compact-js';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

import { ensureCompiledArtifacts } from './check-artifacts.js';

// Required for GraphQL subscriptions in Node.
// @ts-expect-error The SDK expects WebSocket on the global scope.
globalThis.WebSocket = WebSocket;

setNetworkId('preprod');

export const CONFIG = {
  indexer: 'https://indexer.preprod.midnight.network/api/v3/graphql',
  indexerWS: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
  node: 'https://rpc.preprod.midnight.network',
  proofServer: 'http://127.0.0.1:6300',
} as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const zkConfigPath = path.resolve(
  __dirname,
  '..',
  'contracts',
  'managed',
  'hello-world',
);

type HelloWorldModule = typeof import('../contracts/managed/hello-world/contract/index.js');
type HelloWorldContract = CompactContract<undefined>;

const helloWorldModulePromise = (async () => {
  ensureCompiledArtifacts();
  return import(pathToFileURL(path.join(zkConfigPath, 'contract', 'index.js')).href) as Promise<HelloWorldModule>;
})();

export const HelloWorld = await helloWorldModulePromise;

const HelloWorldContractCtor =
  HelloWorld.Contract as unknown as new (
    witnesses: Record<string, never>,
  ) => HelloWorldContract;

export const compiledContract = CompiledContract.make(
  'hello-world',
  HelloWorldContractCtor,
).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);

export function deriveKeys(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');

  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');

  hdWallet.hdWallet.clear();
  return result.keys;
}

export async function createWallet(seed: string) {
  const keys = deriveKeys(seed);
  const networkId = getNetworkId();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

  const walletConfig = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: CONFIG.indexer,
      indexerWsUrl: CONFIG.indexerWS,
    },
    provingServerUrl: new URL(CONFIG.proofServer),
    relayURL: new URL(CONFIG.node.replace(/^http/, 'ws')),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
  };

  const wallet = await WalletFacade.init({
    configuration: walletConfig,
    shielded: async (config) =>
      ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: async (config) =>
      UnshieldedWallet(config).startWithPublicKey(
        PublicKey.fromKeyStore(unshieldedKeystore),
      ),
    dust: async (config) =>
      DustWallet(config).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { seed, wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

export async function createProviders(
  walletCtx: Awaited<ReturnType<typeof createWallet>>,
) {
  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim();
  if (!privateStatePassword) {
    throw new Error(
      'Missing PRIVATE_STATE_PASSWORD. This repo uses the official encrypted Level private state provider, which requires a strong local encryption password even though the high-level hello-world docs do not mention it.\n' +
        "Set it before running deploy or cli, for example:\nexport PRIVATE_STATE_PASSWORD='Str0ng!MidnightLocal'",
    );
  }

  const state = await walletCtx.wallet.waitForSyncedState();

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: unknown, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx as Parameters<typeof walletCtx.wallet.balanceUnboundTransaction>[0],
        {
          shieldedSecretKeys: walletCtx.shieldedSecretKeys,
          dustSecretKey: walletCtx.dustSecretKey,
        },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );

      const signedRecipe = await walletCtx.wallet.signRecipe(recipe, (payload) =>
        walletCtx.unshieldedKeystore.signData(payload),
      );

      return walletCtx.wallet.finalizeRecipe(signedRecipe);
    },
    submitTx: (tx: ledger.FinalizedTransaction) =>
      walletCtx.wallet.submitTransaction(tx),
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'hello-world-state',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(
      CONFIG.indexer,
      CONFIG.indexerWS,
    ),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(CONFIG.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}
