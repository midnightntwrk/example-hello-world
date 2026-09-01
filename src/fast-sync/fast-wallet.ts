// Assemble a WalletFacade from restored sub-wallets, pre-seeding a brand-new
// wallet from a shipped reference so it starts near chain tip instead of
// genesis. This mirrors testkit's WalletFactory, but takes the `restore()` path
// for whichever sub-wallets a usable reference can seed.
//
// The heavy lifting (the reference, the key-swap, the safety guard) lives in the
// sibling modules; this file only wires them to the SDK.

import { DustSecretKey, LedgerParameters, ZswapSecretKeys } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  InMemoryTransactionHistoryStorage,
  mergeWalletEntries,
  WalletEntrySchema,
  WalletFacade,
} from '@midnight-ntwrk/wallet-sdk';
import { CustomShieldedWallet } from '@midnight-ntwrk/wallet-sdk/shielded';
import { CustomDustWallet } from '@midnight-ntwrk/wallet-sdk/dust';
import { PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk/unshielded';
import {
  type DustWalletOptions,
  type EnvironmentConfiguration,
  FluentWalletBuilder,
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

  // Derive the wallet's keys and keystore through the normal builder, then
  // discard its (never-started, so inert) facade. This reuses the SDK's key
  // derivation rather than reimplementing HD-wallet derivation here.
  const base = FluentWalletBuilder.forEnvironment(env).withDustOptions(DUST_OPTIONS);
  const builder = secret.kind === 'mnemonic' ? base.withMnemonic(secret.value) : base.withSeed(secret.value);
  const { seeds, keystore } = await builder.buildWithoutStarting();

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

  // --- Decide whether to seed, then how much ---
  const reference = loadReferenceBundle(opts.referenceRoot, networkId);
  const birthday = opts.birthday ?? (await getChainTipHeight(env.indexer));
  let seededSnaps: ReturnType<typeof preSeedNewWallet> = null;
  let referenceHeight: number | null = null;

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
    shielded: () => shielded,
    unshielded: () => unshielded,
    dust: () => dust,
  });

  const provider = MidnightWalletProvider.fromParts(logger, facade, zswapSecretKeys, dustSecretKey, keystore);

  const seeded: string[] = [];
  if (seededSnaps?.shielded) seeded.push('shielded');
  if (seededSnaps?.unshielded) seeded.push('unshielded');
  if (seededSnaps?.dust) seeded.push('dust');

  return { provider, seeded, referenceHeight };
}
