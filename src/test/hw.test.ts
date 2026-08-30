import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';

import {
  deployContract,
  findDeployedContract,
  type DeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';

import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';

import {
  type EnvironmentConfiguration,
  waitForFunds,
} from '@midnight-ntwrk/testkit-js';

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import pino from 'pino';

import { getConfig } from '../config.js';

import {
  MidnightWalletProvider,
  syncWallet,
  type WalletSecret,
} from '../wallet.js';

import {
  buildProviders,
  type HelloWorldProviders,
} from '../providers.js';

import {
  CompiledMindVaultContract,
  Contract,
  ledger,
  zkConfigPath,
} from '../../contracts/index.js';


// -----------------------------------------------------------------------------
// WebSocket
// -----------------------------------------------------------------------------

globalThis.WebSocket =
  WebSocket as unknown as typeof globalThis.WebSocket;


// -----------------------------------------------------------------------------
// Local test wallet
// -----------------------------------------------------------------------------

const ALICE_LOCAL_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';


// -----------------------------------------------------------------------------
// Private state
// -----------------------------------------------------------------------------

const PRIVATE_STATE_ID = 'AlicePrivateMindVaultState';


// -----------------------------------------------------------------------------
// Logger
// -----------------------------------------------------------------------------

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: {
    target: 'pino-pretty',
  },
});


// -----------------------------------------------------------------------------
// Network
// -----------------------------------------------------------------------------

const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';


// -----------------------------------------------------------------------------
// Resolve wallet secret
// -----------------------------------------------------------------------------

function resolveSecret(net: string): WalletSecret {
  if (net === 'local') {
    return {
      kind: 'seed',
      value: ALICE_LOCAL_SEED,
    };
  }

  const upper = net.toUpperCase();

  const mnemonicEnv = `MIDNIGHT_${upper}_MNEMONIC`;
  const seedEnv = `MIDNIGHT_${upper}_SEED`;

  const mnemonic = process.env[mnemonicEnv]
    ?.trim()
    .replace(/\s+/g, ' ');

  const seedHex = process.env[seedEnv]?.trim();

  if (mnemonic && seedHex) {
    throw new Error(
      `Set only one of ${mnemonicEnv} or ${seedEnv}.`,
    );
  }

  if (mnemonic) {
    return {
      kind: 'mnemonic',
      value: mnemonic,
    };
  }

  if (seedHex) {
    return {
      kind: 'seed',
      value: seedHex,
    };
  }

  throw new Error(
    `Either ${mnemonicEnv} or ${seedEnv} is required for network '${net}'.`,
  );
}


// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe(`MindVault Contract (${network})`, () => {

  let wallet: MidnightWalletProvider;

  let providers: HelloWorldProviders;

  let contractAddress: ContractAddress;


  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  const config = getConfig();

  const secret = resolveSecret(network);


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


    // Build wallet
    wallet = await MidnightWalletProvider.build(
      logger,
      envConfig,
      secret,
    );


    // Start wallet
    await wallet.start();


    // Synchronize wallet
    await syncWallet(
      logger,
      wallet.wallet,
      Number(
        process.env['MIDNIGHT_SYNC_TIMEOUT_MS'] ??
        600000,
      ),
    );


    // For non-local networks, wait for funds
    if (network !== 'local') {

      const nightBalance = await waitForFunds(
        wallet.wallet,
        envConfig,
        false,
        wallet.unshieldedKeystore,
      );

      logger.info(
        `Wallet NIGHT balance: ${nightBalance}`,
      );
    }


    // Build Midnight providers
    providers = buildProviders(
      wallet,
      zkConfigPath,
      config,
    );


    logger.info(
      `MindVault providers initialized on '${network}'.`,
    );
  });


  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  afterAll(async () => {

    if (wallet) {
      await wallet.stop();
    }
  });


  // ---------------------------------------------------------------------------
  // Test 1 — Deploy contract
  // ---------------------------------------------------------------------------

  it('Deploys the MindVault contract', async () => {

    const deployed: DeployedContract<Contract> =
      await deployContract<Contract>(
        providers,
        {
          compiledContract:
            CompiledMindVaultContract,

          privateStateId:
            PRIVATE_STATE_ID,

          initialPrivateState: {},
        },
      );


    // Save contract address
    contractAddress =
      deployed.deployTxData.public.contractAddress;


    // Check address
    expect(contractAddress).toBeDefined();

    expect(contractAddress.length).toBeGreaterThan(0);


    // Query blockchain state
    const state =
      await providers.publicDataProvider.queryContractState(
        contractAddress,
      );


    expect(state).not.toBeNull();


    // Read ledger
    const ledgerState =
      ledger(state!.data);


    // Initial value should be 0
    expect(
      ledgerState.journalCount,
    ).toBe(0n);


    logger.info(
      `MindVault deployed at: ${contractAddress}`,
    );
  });


  // ---------------------------------------------------------------------------
  // Test 2 — Record journal entry
  // ---------------------------------------------------------------------------

  it('Records a private journal entry', async () => {

    // Find the contract that was deployed
    const deployed =
      await findDeployedContract<Contract>(
        providers,
        {
          compiledContract:
            CompiledMindVaultContract,

          contractAddress:
            contractAddress,

          privateStateId:
            PRIVATE_STATE_ID,

          initialPrivateState: {},
        },
      );


    // Call the Compact circuit
    await deployed.callTx.recordJournal();


    // Query updated blockchain state
    const state =
      await providers.publicDataProvider.queryContractState(
        contractAddress,
      );


    expect(state).not.toBeNull();


    // Read updated ledger
    const ledgerState =
      ledger(state!.data);


    // journalCount should now be 1
    expect(
      ledgerState.journalCount,
    ).toBe(1n);


    logger.info(
      'MindVault journal entry recorded successfully.',
    );
  });

});
