import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

import {
  deployContract,
  findDeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import {
  waitForFunds,
} from '@midnight-ntwrk/testkit-js';

import pino from 'pino';

import {
  MidnightWalletProvider,
  syncWallet,
} from '../../src/wallet.js';

import {
  buildProviders,
} from '../../src/providers.js';

import {
  CompiledMindVaultContract,
  Contract,
  zkConfigPath,
  ledger,
} from '../../contracts/index.js';

import {
  getConfig,
} from '../../src/config.js';


// ============================================================
// Express
// ============================================================

const app = express();

app.use(cors());
app.use(express.json());


// ============================================================
// Gemini
// ============================================================

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error('GEMINI_API_KEY is missing');
  process.exit(1);
}

console.log('API key loaded: true');

const ai = new GoogleGenAI({
  apiKey,
});


// ============================================================
// MindVault AI prompt
// ============================================================

const SYSTEM_PROMPT = `
You are MindVault, a supportive AI wellness companion.

Your role:
- Listen without judgment.
- Help users reflect on their emotions and situations.
- Ask thoughtful, concise follow-up questions.
- Offer practical, low-risk coping strategies when appropriate.
- Never claim to be a therapist, doctor, or mental-health professional.
- Never diagnose mental-health conditions.
- Do not encourage dependency on the AI.
- If the user appears to be in immediate danger or considering self-harm,
  encourage them to contact local emergency services or a trusted person
  immediately.

Keep responses empathetic, natural, and reasonably concise.
`;


// ============================================================
// Midnight configuration
// ============================================================

const network = process.env.MIDNIGHT_NETWORK ?? 'local';

const config = getConfig();

const PRIVATE_STATE_ID = 'MindVaultWebState';

const ALICE_LOCAL_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';


// ============================================================
// Logger
// ============================================================

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: {
    target: 'pino-pretty',
  },
});


// ============================================================
// Midnight wallet/provider
// ============================================================

let wallet;
let providers;
let deployedContract;
let midnightReady = false;


// ============================================================
// Wallet secret
// ============================================================

function resolveSecret(net) {
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


// ============================================================
// Start Midnight
// ============================================================

async function startMidnight() {
  console.log('');
  console.log('==========================================');
  console.log('Starting MindVault Midnight connection');
  console.log('==========================================');

  setNetworkId(config.networkId);

  const envConfig = {
    walletNetworkId: config.networkId,
    networkId: config.networkId,
    indexer: config.indexer,
    indexerWS: config.indexerWS,
    node: config.node,
    nodeWS: config.nodeWS,
    faucet: config.faucet,
    proofServer: config.proofServer,
  };

  const secret = resolveSecret(network);

  console.log(`Midnight network: ${network}`);

  // Build wallet
  wallet = await MidnightWalletProvider.build(
    logger,
    envConfig,
    secret,
  );

  console.log('Wallet built');

  // Start wallet
  await wallet.start();

  console.log('Wallet started');

  // Sync wallet
  await syncWallet(
    logger,
    wallet.wallet,
    Number(
      process.env.MIDNIGHT_SYNC_TIMEOUT_MS ?? 600000,
    ),
  );

  console.log('Wallet synchronized');

  // Local network does not need faucet funding
  if (network !== 'local') {
    const nightBalance = await waitForFunds(
      wallet.wallet,
      envConfig,
      false,
      wallet.unshieldedKeystore,
    );

    console.log(
      `Wallet NIGHT balance: ${nightBalance}`,
    );
  }

  // Build providers
  providers = buildProviders(
    wallet,
    zkConfigPath,
    config,
  );

  console.log('Midnight providers ready');


  // ----------------------------------------------------------
  // Deploy MindVault contract
  // ----------------------------------------------------------

  console.log('Deploying MindVault contract...');

  deployedContract = await deployContract(
    providers,
    {
      compiledContract:
        CompiledMindVaultContract,

      privateStateId:
        PRIVATE_STATE_ID,

      initialPrivateState: {},
    },
  );

  midnightReady = true;

  console.log('');
  console.log('==========================================');
  console.log('MindVault contract deployed');
  console.log(
    `Contract address: ${deployedContract.deployTxData.public.contractAddress}`,
  );
  console.log('==========================================');
  console.log('');
}


// ============================================================
// AI CHAT
// ============================================================

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: 'Message is required.',
      });
    }

    console.log('AI request received');

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: `${SYSTEM_PROMPT}

User: ${message.trim()}`,
    });

    const reply = response.text;

    res.json({
      reply,
    });

  } catch (error) {
    console.error('GEMINI ERROR:', error);

    res.status(500).json({
      error: 'MindVault AI could not respond right now.',
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
});

// ============================================================
// SAVE JOURNAL
// ============================================================

app.post('/api/journal', async (req, res) => {
  try {

    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: 'Journal entry is required.',
      });
    }

    if (!midnightReady || !deployedContract) {
      return res.status(503).json({
        error: 'Midnight is not ready yet.',
      });
    }

    console.log('');
    console.log('==========================================');
    console.log('Recording private journal entry');
    console.log('==========================================');

    // Call the actual Compact circuit
    await deployedContract.callTx.recordJournal();

    console.log(
      'recordJournal transaction submitted',
    );


    // Read updated ledger state
    const contractAddress =
      deployedContract.deployTxData.public.contractAddress;

    const state =
      await providers.publicDataProvider.queryContractState(
        contractAddress,
      );

    if (!state) {
      throw new Error(
        'Could not read MindVault contract state.',
      );
    }

    const ledgerState = ledger(state.data);

    console.log(
      `Journal count: ${ledgerState.journalCount}`,
    );


    res.json({
      success: true,

      message:
        'Journal entry recorded privately on Midnight.',

      journalCount:
        Number(ledgerState.journalCount),

      contractAddress,
    });

  } catch (error) {

    console.error(
      'MIDNIGHT JOURNAL ERROR:',
      error,
    );

    res.status(500).json({
      error:
        'Could not save the journal entry on Midnight.',

      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
});


// ============================================================
// STATUS
// ============================================================

app.get('/api/status', async (_req, res) => {

  res.json({
    ai: true,
    midnight: midnightReady,
    contractAddress:
      deployedContract
        ? deployedContract.deployTxData.public.contractAddress
        : null,
  });

});


// ============================================================
// Start server
// ============================================================

const PORT = 3001;

async function start() {

  try {

    await startMidnight();

    app.listen(PORT, () => {

      console.log(
        `MindVault AI server running on http://localhost:${PORT}`,
      );

      console.log(
        'Midnight integration: READY',
      );

    });

  } catch (error) {

    console.error(
      'FAILED TO START MINDVAULT:',
      error,
    );

    process.exit(1);
  }
}


start();
