import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  deployContract,
  submitCallTx,
  type DeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  type EnvironmentConfiguration,
  waitForFunds,
} from '@midnight-ntwrk/testkit-js';
import pino from 'pino';

import { getConfig } from '../config.js';
import {
  MidnightWalletProvider,
  syncWallet,
  type WalletSecret,
} from '../wallet.js';
import { getChainTipHeight, type FastSyncOptions } from '../fast-sync/fast-wallet.js';
import { getOrCreateTestWallet } from '../fast-sync/test-wallet.js';
import { buildProviders, type HelloWorldProviders } from '../providers.js';

// Shipped pre-seed reference bundles, and where generated wallets are cached.
const REFERENCE_ROOT = fileURLToPath(new URL('../../preseed', import.meta.url));
const WALLETS_DIR = fileURLToPath(new URL('../../.fast-sync-wallets', import.meta.url));
import {
  CompiledHelloWorldContract,
  Contract,
  ledger,
  zkConfigPath,
} from '../../contracts/index.js';

// Required for GraphQL subscriptions in Node.js
// @ts-expect-error WebSocket global assignment for apollo
globalThis.WebSocket = WebSocket;

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
  console.error('Promise:', promise);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

const ALICE_LOCAL_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';
const PRIVATE_STATE_ID = 'AlicePrivateHWState';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: { target: 'pino-pretty' },
});

const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';

// A wallet explicitly supplied via .env.<network> (MIDNIGHT_<NET>_SEED or
// _MNEMONIC), or null when none is set. This is the fallback path: a wallet that
// already has on-chain history cannot be fast-synced (the guard refuses it), so
// it is only used when a developer deliberately provides one.
function tryEnvSecret(net: string): WalletSecret | null {
  const upper = net.toUpperCase();
  const mnemonicEnv = `MIDNIGHT_${upper}_MNEMONIC`;
  const seedEnv = `MIDNIGHT_${upper}_SEED`;
  const mnemonic = process.env[mnemonicEnv]?.trim().replace(/\s+/g, ' ');
  const seedHex = process.env[seedEnv]?.trim();

  if (mnemonic && seedHex) {
    throw new Error(`Set only one of ${mnemonicEnv} or ${seedEnv} (both are defined).`);
  }
  if (mnemonic) return { kind: 'mnemonic', value: mnemonic };
  if (seedHex) {
    if (!/^[0-9a-fA-F]+$/.test(seedHex) || seedHex.length % 2 !== 0) {
      throw new Error(`${seedEnv} must be a hex string of even length (no 0x prefix).`);
    }
    return { kind: 'seed', value: seedHex };
  }
  return null;
}

interface WalletSetup {
  secret: WalletSecret;
  fastSync?: FastSyncOptions;
  /** True when a fresh wallet was just generated and still needs funding. */
  isNew: boolean;
}

// Resolve the wallet for a run. The DEFAULT — the standard developer entry point
// — is a freshly generated wallet that fast-syncs from the shipped reference. A
// wallet with history supplied via .env is the fallback, taking a normal full
// sync (fast-sync cannot safely seed a wallet that predates the reference).
async function resolveWallet(net: string, config: ReturnType<typeof getConfig>): Promise<WalletSetup> {
  if (net === 'local') {
    return { secret: { kind: 'seed', value: ALICE_LOCAL_SEED }, isNew: false };
  }

  const imported = tryEnvSecret(net);
  if (imported) {
    logger.info(`Using the wallet from .env.${net} — full sync (fast-sync applies only to freshly generated wallets).`);
    return { secret: imported, isNew: false };
  }

  const tip = await getChainTipHeight(config.indexer);
  if (tip === undefined) {
    throw new Error(`Could not read the ${net} chain tip to set the new wallet's birthday.`);
  }
  const { wallet, isNew } = getOrCreateTestWallet(WALLETS_DIR, config.networkId, tip);
  logger.info(
    isNew
      ? `Generated a new ${net} wallet (birthday ${wallet.birthday}); it will fast-sync, then you will be asked to fund it.`
      : `Reusing the saved ${net} wallet (birthday ${wallet.birthday}).`,
  );
  return {
    secret: { kind: 'seed', value: wallet.seed },
    fastSync: { referenceRoot: REFERENCE_ROOT, birthday: wallet.birthday },
    isNew,
  };
}

describe(`Hello World Contract (${network})`, () => {
  let wallet: MidnightWalletProvider;
  let providers: HelloWorldProviders;
  let contractAddress: ContractAddress;

  const config = getConfig();
  const isRemote = network !== 'local';
  const syncTimeoutMs = Number(
    process.env['MIDNIGHT_SYNC_TIMEOUT_MS'] ??
      (isRemote ? 60 * 60_000 : 10 * 60_000),
  );

  async function queryLedger(p: HelloWorldProviders) {
    const state = await p.publicDataProvider.queryContractState(contractAddress);
    expect(state).not.toBeNull();
    return ledger(state!.data);
  }

  beforeAll(async () => {
    setNetworkId(config.networkId);

    const envConfig: EnvironmentConfiguration = {
      walletNetworkId: config.networkId,
      networkId: config.networkId,
      indexer: config.indexer,
      indexerWS: config.indexerWS,
      node: config.node,
      nodeWS: config.nodeWS,
      faucet: config.faucet,
      proofServer: config.proofServer,
    };

    const setup = await resolveWallet(network, config);
    wallet = await MidnightWalletProvider.build(logger, envConfig, setup.secret, {
      fastSync: setup.fastSync,
    });
    await wallet.start();
    await syncWallet(logger, wallet.wallet, syncTimeoutMs);

    if (isRemote) {
      // A freshly generated wallet holds no NIGHT. Show its address and pause
      // here (waitForFunds polls) until the developer funds it at the faucet;
      // then it registers for DUST. An already-funded wallet returns at once.
      const address = String(wallet.unshieldedKeystore.getBech32Address());
      logger.info('────────────────────────────────────────────────────────────');
      logger.info('Fund this wallet with NIGHT — the suite continues automatically once it arrives:');
      logger.info(`  address: ${address}`);
      logger.info(`  faucet:  ${config.faucet}`);
      logger.info('Waiting for NIGHT...');
      logger.info('────────────────────────────────────────────────────────────');
      const nightBalance = await waitForFunds(
        wallet.wallet,
        envConfig,
        false,
        wallet.unshieldedKeystore,
      );
      logger.info(`Wallet NIGHT balance on '${network}': ${nightBalance}`);
    }

    providers = buildProviders(wallet, zkConfigPath, config);
    logger.info(`Providers initialized on '${network}'. Ready to test!`);
  });

  afterAll(async () => {
    if (wallet) {
      logger.info('Stopping wallet...');
      await wallet.stop();
    }
  });

  it('Deploys the contract', async () => {
    logger.info(`Creating private state...`);

    const deployed: DeployedContract<Contract> =
      await (deployContract<Contract>)(providers, {
        compiledContract: CompiledHelloWorldContract,
        privateStateId: PRIVATE_STATE_ID,
        initialPrivateState: {},
      });

    logger.info(`Setting the contract address...`);
    contractAddress = deployed.deployTxData.public.contractAddress;
    logger.info(`Contract deployed at: ${contractAddress}`);
    expect(contractAddress).toBeDefined();
    expect(contractAddress.length).toBeGreaterThan(0);

    const state = await queryLedger(providers);
    expect(state.message).toEqual('');
  });

  it('Stores Hello World!', async () => {
    const message = 'Hello World!';

    await (submitCallTx<Contract, 'storeMessage'>)(providers, {
      compiledContract: CompiledHelloWorldContract,
      contractAddress,
      privateStateId: PRIVATE_STATE_ID,
      circuitId: 'storeMessage',
      args: [message],
    });

    const state = await queryLedger(providers);
    expect(state.message).toEqual(message);
  });
});
