// Fast-sync demo: build a brand-new wallet and sync it via a shipped pre-seed
// reference instead of walking the chain from genesis.
//
//   MIDNIGHT_NETWORK=preprod vite-node scripts/fast-sync-demo.ts
//   MIDNIGHT_NETWORK=preview vite-node scripts/fast-sync-demo.ts
//
// Optional:
//   FAST_SYNC_TIMEOUT_MS=600000   how long to wait for full sync (default 600s)
//   FAST_SYNC_BASELINE=1          ALSO time an un-seeded wallet for comparison
//                                 (slow: ~78 min on preprod — off by default)
//
// A fresh random seed is generated each run, so the wallet is empty and its
// birthday is "now" — always safe to seed. Requires network access to the
// selected network's indexer and node; no proof server is needed for sync.

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import { getConfig } from '../src/config.js';
import { MidnightWalletProvider, syncWallet, type WalletSecret } from '../src/wallet.js';
import { buildFastSyncedProvider } from '../src/fast-sync/fast-wallet.js';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: { target: 'pino-pretty' },
});

const config = getConfig();
setNetworkId(config.networkId);
const env: EnvironmentConfiguration = { walletNetworkId: config.networkId, ...config };
const referenceRoot = fileURLToPath(new URL('../preseed', import.meta.url));
const timeoutMs = Number(process.env['FAST_SYNC_TIMEOUT_MS'] ?? 600_000);

function freshSeed(): WalletSecret {
  return { kind: 'seed', value: randomBytes(32).toString('hex') };
}

async function timeToSynced(provider: MidnightWalletProvider): Promise<number> {
  const started = Date.now();
  await provider.start();
  await syncWallet(logger, provider.wallet, timeoutMs);
  return Date.now() - started;
}

async function main(): Promise<void> {
  logger.info(`Fast-sync demo on '${config.networkId}' (reference dir: ${referenceRoot})`);

  const { provider, seeded, referenceHeight } = await buildFastSyncedProvider(
    logger,
    env,
    freshSeed(),
    { referenceRoot },
  );

  if (seeded.length === 0) {
    logger.warn('No sub-wallet was seeded — this run is a full genesis sync (see logs above for why).');
  } else {
    logger.info(`Seeded [${seeded.join(', ')}] from reference at height ${referenceHeight}.`);
  }

  let fastMs: number;
  try {
    fastMs = await timeToSynced(provider);
    logger.info(`✅ Fast-synced in ${(fastMs / 1000).toFixed(1)}s (seeded: ${seeded.join(', ') || 'none'}).`);
  } finally {
    await provider.stop().catch((err: unknown) => logger.warn(`stop() failed: ${String(err)}`));
  }

  if (process.env['FAST_SYNC_BASELINE'] === '1') {
    logger.info('Baseline: syncing an un-seeded wallet from genesis for comparison (this is slow)...');
    const baseline = await MidnightWalletProvider.build(logger, env, freshSeed());
    try {
      const baseMs = await timeToSynced(baseline);
      logger.info(
        `Baseline (no reference): ${(baseMs / 1000).toFixed(1)}s vs fast-sync ${(fastMs / 1000).toFixed(1)}s ` +
          `— ${(baseMs / fastMs).toFixed(1)}x faster.`,
      );
    } finally {
      await baseline.stop().catch((err: unknown) => logger.warn(`baseline stop() failed: ${String(err)}`));
    }
  }
}

main().catch((err: unknown) => {
  logger.error(`fast-sync-demo failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
});
