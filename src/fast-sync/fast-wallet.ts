// Assemble a WalletFacade from restored sub-wallets, pre-seeding a brand-new
// wallet from a shipped reference so it starts near chain tip instead of
// genesis. This mirrors testkit's WalletFactory, but takes the `restore()` path
// for whichever sub-wallets a usable reference can seed.
//
// The heavy lifting (the reference, the key-swap, the safety guard) lives in the
// sibling modules; this file only wires them to the SDK.

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
  WalletEntrySchema,
  WalletFacade,
} from '@midnight-ntwrk/wallet-sdk';
import { makeDefaultSubmissionService, type SubmissionService } from '@midnight-ntwrk/wallet-sdk/capabilities/submission';
import { CustomShieldedWallet } from '@midnight-ntwrk/wallet-sdk/shielded';
import { CustomDustWallet } from '@midnight-ntwrk/wallet-sdk/dust';
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk/unshielded';
import {
  type DustWalletOptions,
  type EnvironmentConfiguration,
  WalletSeeds,
} from '@midnight-ntwrk/testkit-js';
import type { Logger } from 'pino';
import { MidnightWalletProvider, type WalletSecret } from '../wallet.js';
import { dedupingDustBuilder, dedupingShieldedBuilder } from './dedup.js';
import { isSeedable, preSeedNewWallet } from './preseed.js';
import { loadReferenceBundle } from './reference-bundle.js';

const DUST_OPTIONS: DustWalletOptions = {
  ledgerParams: LedgerParameters.initialParameters(),
  additionalFeeOverhead: 1_000n,
  feeBlocksMargin: 5,
};

export interface FastSyncOptions {
  /** Directory holding `<networkId>/{manifest.json,*.dat.gz}` reference bundles. */
  referenceRoot: string;
  /**
   * The wallet's birthday (chain height at creation) for the safety guard. Omit
   * and it is read from the indexer's current tip — correct for a wallet created
   * now. A restored/funded wallet must NOT pass a tip here; it has no safe
   * shortcut and should sync from genesis.
   */
  birthday?: number;
}

export interface FastSyncResult {
  provider: MidnightWalletProvider;
  /** Which sub-wallets were seeded from the reference (empty = full sync). */
  seeded: string[];
  /** The reference height used, or null when none was applied. */
  referenceHeight: number | null;
}

/**
 * A submission service that defers building the real (node-connecting) one until
 * the first submit. Facade init then opens no node client, so an unresponsive
 * relay cannot stall startup with a 60s RPC-init timeout — sync uses the indexer,
 * never the node. A wallet that actually submits pays the connection cost lazily.
 */
function lazySubmissionService(relayURL: URL): SubmissionService<FinalizedTransaction> {
  let inner: SubmissionService<FinalizedTransaction> | undefined;
  const get = (): SubmissionService<FinalizedTransaction> =>
    (inner ??= makeDefaultSubmissionService<FinalizedTransaction>({ relayURL }));
  return {
    submitTransaction: ((tx: FinalizedTransaction, waitForStatus?: 'Submitted' | 'InBlock' | 'Finalized') =>
      get().submitTransaction(tx, waitForStatus)) as SubmissionService<FinalizedTransaction>['submitTransaction'],
    close: async (): Promise<void> => {
      if (inner) await inner.close();
    },
  };
}

/** Read the indexer's current tip height, or undefined if it cannot be reached. */
async function getChainTipHeight(indexerHttpUrl: string): Promise<number | undefined> {
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
 * Build a MidnightWalletProvider whose sub-wallets are restored from the shipped
 * reference where it is safe to do so. The returned provider is NOT started —
 * call `.start()` then `syncWallet()` exactly as with `MidnightWalletProvider.build`.
 */
export async function buildFastSyncedProvider(
  logger: Logger,
  env: EnvironmentConfiguration,
  secret: WalletSecret,
  opts: FastSyncOptions,
): Promise<FastSyncResult> {
  const networkId = env.walletNetworkId;
  setNetworkId(networkId);

  // Phase timing, quiet unless LOG_LEVEL=debug. On preprod the dominant cost is
  // `dust restore` (~72s) — deserializing the ~10.9 MB global generation tree into
  // WASM — not any network call. Everything else is sub-second.
  let _t = Date.now();
  const mark = (label: string): void => {
    const now = Date.now();
    logger.debug(`  [timing] ${label}: ${((now - _t) / 1000).toFixed(1)}s`);
    _t = now;
  };

  // Derive the wallet's keys directly. WalletSeeds runs the same HD derivation
  // the FluentWalletBuilder uses, but as pure crypto — no throwaway facade, and no
  // node client eagerly connecting to the relay (which, against an unresponsive
  // RPC endpoint, spends 60s timing out in the background and spams errors). This
  // is a cleanliness win, not the speed win: the dominant startup cost is the dust
  // restore below, and this derivation is sub-second.
  const seeds = secret.kind === 'mnemonic' ? WalletSeeds.fromMnemonic(secret.value) : WalletSeeds.fromMasterSeed(secret.value);
  const keystore = createKeystore(seeds.unshielded, networkId);

  const zswapSecretKeys = ZswapSecretKeys.fromSeed(seeds.shielded);
  const dustSecretKey = DustSecretKey.fromSeed(seeds.dust);
  const unshieldedPublicKey = PublicKey.fromKeyStore(keystore);
  mark('key derivation');

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

  // --- Decide whether to seed, then how much ---
  const reference = loadReferenceBundle(opts.referenceRoot, networkId);
  mark('loadReferenceBundle (gunzip)');
  const birthday = opts.birthday ?? (await getChainTipHeight(env.indexer));
  mark('getChainTipHeight');
  let seededSnaps: ReturnType<typeof preSeedNewWallet> = null;
  let referenceHeight: number | null = null;

  if (reference && isSeedable(reference, birthday)) {
    seededSnaps = preSeedNewWallet({ shieldedSecretKeys: zswapSecretKeys, unshieldedPublicKey, dustSecretKey }, networkId, reference);
    mark('preSeedNewWallet (key-swap)');
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
  mark('shielded+unshielded restore');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dustBuilder = dedupingDustBuilder() as any;
  const dust = seededSnaps?.dust
    ? CustomDustWallet(dustConfig, dustBuilder).restore(seededSnaps.dust)
    : CustomDustWallet(dustConfig, dustBuilder).startWithSecretKey(
        dustSecretKey,
        LedgerParameters.initialParameters().dust,
      );
  mark('dust restore');

  const facade = await WalletFacade.init({
    configuration: config,
    // Lazy so facade init opens no node connection (see lazySubmissionService).
    submissionService: () => lazySubmissionService(new URL(env.nodeWS)),
    shielded: () => shielded,
    unshielded: () => unshielded,
    dust: () => dust,
  });
  mark('WalletFacade.init');

  const provider = MidnightWalletProvider.fromParts(logger, facade, zswapSecretKeys, dustSecretKey, keystore);

  const seeded: string[] = [];
  if (seededSnaps?.shielded) seeded.push('shielded');
  if (seededSnaps?.unshielded) seeded.push('unshielded');
  if (seededSnaps?.dust) seeded.push('dust');

  return { provider, seeded, referenceHeight };
}
