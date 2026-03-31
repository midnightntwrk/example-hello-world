import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  deployContract,
  submitCallTx,
} from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractAddress } from '@midnight-ntwrk/compact-runtime';
import pino from 'pino';

import { getConfig } from '../config.js';
import { MidnightWalletProvider, syncWallet } from '../wallet.js';
import { buildProviders, type HelloWorldProviders } from '../providers.js';
import {
  CompiledHelloWorldContract,
  ledger,
  zkConfigPath,
} from '../../contracts/index.js';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';

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

const ALICE_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';
const ALICE_PRIVATE_STATE_ID = 'AlicePrivateHWState';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: { target: 'pino-pretty' },
});

describe('Hello World Contract', () => {
  let aliceWallet: MidnightWalletProvider;
  let aliceProviders: HelloWorldProviders;
  let contractAddress: ContractAddress;

  const config = getConfig();

  async function queryLedger(providers: HelloWorldProviders) {
    const state = 
      await providers.publicDataProvider.queryContractState(contractAddress);
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

    aliceWallet = await MidnightWalletProvider.build(logger, envConfig, ALICE_SEED!);
    await aliceWallet.start();
    await syncWallet(logger, aliceWallet.wallet, 600_000);

    aliceProviders = buildProviders(aliceWallet, zkConfigPath, config);
    logger.info(`Providers initialized. Ready to test!`);
  });

  afterAll(async () => {
    if(aliceWallet) {
      logger.info('Stopping Alice wallet...');
      await aliceWallet.stop();
    }
  });

  it('Deploys the contract', async () => {
    logger.info(`Creating private state...`);

    const deployed: any = await (deployContract as any)(aliceProviders, {
      compiledContract: CompiledHelloWorldContract,
      privateStateId: ALICE_PRIVATE_STATE_ID,
      initialPrivateState: {},
      args: [],
    });

    logger.info(`Setting the contract address...`);
    contractAddress = deployed.deployTxData.public.contractAddress;
    logger.info(`Contract deployed at: ${contractAddress}`);
    expect(contractAddress).toBeDefined();
    expect(contractAddress.length).toBeGreaterThan(0);

    const state = await queryLedger(aliceProviders);
    expect(state.message).toEqual("");
  });
  it('Stores Hello World!', async () => {
    const message = "Hello World!";

    await (submitCallTx as any)(aliceProviders, {
      compiledContract: CompiledHelloWorldContract,
      contractAddress,
      privateStateId: ALICE_PRIVATE_STATE_ID,
      circuitId: 'storeMessage',
      args: [message],
    });

    const state = await queryLedger(aliceProviders);
    expect(state.message).toEqual(message);
  });
});
