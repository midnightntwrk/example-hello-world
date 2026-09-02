// Assemble a WalletFacade from restored sub-wallets, pre-seeding a brand-new
// wallet from a shipped reference so it starts near chain tip instead of
// genesis. This mirrors testkit's WalletFactory, but takes the `restore()` path
// for whichever sub-wallets a usable reference can seed.
//
// This is the engine behind MidnightWalletProvider.build. It returns the facade
// and keys; the provider wrapping lives in wallet.ts.

import {
  DustSecretKey,
  type FinalizedTransaction,
  LedgerParameters,
  ZswapSecretKeys,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  InMemoryTransactionHistoryStorage,
  mergeWalletEntries,
  type UnshieldedKeystore,
  WalletEntrySchema,
  WalletFacade,
} from '@midnight-ntwrk/wallet-sdk';
import { robustSubmissionService } from './submission.js';
import { CustomShieldedWallet } from '@midnight-ntwrk/wallet-sdk/shielded';
import { CustomDustWallet } from '@midnight-ntwrk/wallet-sdk/dust';
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk/unshielded';
import { type DustWalletOptions, type EnvironmentConfiguration, WalletSeeds } from '@midnight-ntwrk/testkit-js';
import type { Logger } from 'pino';
import type { WalletSecret } from '../wallet.js';
import { dedupingDustBuilder, dedupingShieldedBuilder } from './dedup.js';
import { isSeedable, preSeedNewWallet } from './preseed.js';
import { loadReferenceBundle } from './reference-bundle.js';

const DUST_OPTIONS: DustWalletOptions = {
  ledgerParams: LedgerParameters.initialParameters(),
  additionalFeeOverhead: 1_000n,
  feeBlocksMargin: 5,
};

/** Opt-in fast-sync configuration. Omit it entirely for a normal genesis sync. */
export interface FastSyncOptions {
  /** Directory holding `<networkId>/{manifest.json,*.dat.gz}` reference bundles. */
  referenceRoot: string;
  /**
   * The wallet's birthday (chain height at creation) for the safety guard. Omit
   * and it is read from the indexer's current tip — correct ONLY for a wallet
   * created right now. A wallet with prior history must pass the height it was
   * created at, or it must not enable fast-sync at all.
   */
  birthday?: number;
}

/** What `assembleWallet` hands back for the provider to wrap. */
export interface AssembledWallet {
  facade: WalletFacade;
  zswapSecretKeys: ZswapSecretKeys;
  dustSecretKey: DustSecretKey;
  keystore: UnshieldedKeystore;
  /** Which sub-wallets were seeded from the reference (empty = full sync). */
  seeded: string[];
  /** Reference height used, or null when none was applied. */
  referenceHeight: number | null;
}

/** Read the indexer's current tip height, or undefined if it cannot be reached. */
export async function getChainTipHeight(indexerHttpUrl: string): Promise<number | undefined> {
  try {
    const res = await fetch(indexerHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query { block { height } }' }),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: { block?: { height?: number } | null } };
    const height = json.data?.block?.height;
    return typeof height === 'number' && height > 0 ? height : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derive keys, optionally pre-seed from the shipped reference (when safe), and
 * build an un-started WalletFacade. Pass no `fastSync` for a normal genesis sync.
 */
export async function assembleWallet(
  logger: Logger,
  env: EnvironmentConfiguration,
  secret: WalletSecret,
  fastSync?: FastSyncOptions,
): Promise<AssembledWallet> {
  const networkId = env.walletNetworkId;
  setNetworkId(networkId);

  // Derive the wallet's keys directly — pure crypto, no throwaway facade and no
  // node client. This is the same HD derivation the FluentWalletBuilder uses.
  const seeds = secret.kind === 'mnemonic' ? WalletSeeds.fromMnemonic(secret.value) : WalletSeeds.fromMasterSeed(secret.value);
  const keystore = createKeystore(seeds.unshielded, networkId);
  const zswapSecretKeys = ZswapSecretKeys.fromSeed(seeds.shielded);
  const dustSecretKey = DustSecretKey.fromSeed(seeds.dust);
  const unshieldedPublicKey = PublicKey.fromKeyStore(keystore);

  // The same shared facade configuration testkit builds from an environment.
  const config = {
    indexerClientConnection: { indexerHttpUrl: env.indexer, indexerWsUrl: env.indexerWS },
    provingServerUrl: new URL(env.proofServer),
    networkId,
    relayURL: new URL(env.nodeWS),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: { feeBlocksMargin: 5 },
  };
  const dustConfig = {
    ...config,
    costParameters: {
      ledgerParams: DUST_OPTIONS.ledgerParams,
      additionalFeeOverhead: DUST_OPTIONS.additionalFeeOverhead,
      feeBlocksMargin: DUST_OPTIONS.feeBlocksMargin,
    },
  };

  // --- Decide whether to seed, then how much (only when fast-sync is enabled) ---
  let seededSnaps: ReturnType<typeof preSeedNewWallet> = null;
  let referenceHeight: number | null = null;

  if (fastSync) {
    const reference = loadReferenceBundle(fastSync.referenceRoot, networkId);
    const birthday = fastSync.birthday ?? (await getChainTipHeight(env.indexer));
    if (reference && isSeedable(reference, birthday)) {
      seededSnaps = preSeedNewWallet({ shieldedSecretKeys: zswapSecretKeys, unshieldedPublicKey, dustSecretKey }, networkId, reference);
      if (seededSnaps) referenceHeight = reference.height;
    } else if (reference) {
      logger.info(
        birthday === undefined
          ? 'Fast-sync: no chain tip to compare against — syncing from genesis'
          : `Fast-sync: reference (height ${reference.height}) is newer than birthday ${birthday} — syncing from genesis`,
      );
    } else {
      logger.info(`Fast-sync: no reference bundle for '${networkId}' — syncing from genesis`);
    }
  }

  // --- Build sub-wallets: restore where seeded, start-from-scratch otherwise ---
  // The deduping builders' inferred type is `unknown` (see dedup.ts); casting to
  // `any` recovers the SDK's default (string-serialized) wallet instantiation,
  // matching what WalletFacade.init expects — the same escape hatch moth uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shieldedBuilder = dedupingShieldedBuilder() as any;
  const shielded = seededSnaps?.shielded
    ? CustomShieldedWallet(config, shieldedBuilder).restore(seededSnaps.shielded)
    : CustomShieldedWallet(config, shieldedBuilder).startWithSecretKeys(zswapSecretKeys);

  const unshieldedCfg = {
    ...config,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  };
  const unshielded = seededSnaps?.unshielded
    ? UnshieldedWallet(unshieldedCfg).restore(seededSnaps.unshielded)
    : UnshieldedWallet(unshieldedCfg).startWithPublicKey(unshieldedPublicKey);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dustBuilder = dedupingDustBuilder() as any;
  const dust = seededSnaps?.dust
    ? CustomDustWallet(dustConfig, dustBuilder).restore(seededSnaps.dust)
    : CustomDustWallet(dustConfig, dustBuilder).startWithSecretKey(
        dustSecretKey,
        LedgerParameters.initialParameters().dust,
      );

  const facade = await WalletFacade.init({
    configuration: config,
    // Robust + lazy: no node connection at facade init (sync uses the indexer);
    // a single persistent connection is opened on first submit. See submission.ts.
    submissionService: () => robustSubmissionService(new URL(env.nodeWS), logger),
    shielded: () => shielded,
    unshielded: () => unshielded,
    dust: () => dust,
  });

  const seeded: string[] = [];
  if (seededSnaps?.shielded) seeded.push('shielded');
  if (seededSnaps?.unshielded) seeded.push('unshielded');
  if (seededSnaps?.dust) seeded.push('dust');
  if (seeded.length > 0) {
    logger.info(`Fast-sync: seeded [${seeded.join(', ')}] from reference at height ${referenceHeight} — sub-wallets start near tip.`);
  }

  return { facade, zswapSecretKeys, dustSecretKey, keystore, seeded, referenceHeight };
}
