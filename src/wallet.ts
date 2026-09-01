import type {
  CoinPublicKey,
  DustSecretKey,
  EncPublicKey,
  FinalizedTransaction,
  ZswapSecretKeys,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type {
  MidnightProvider,
  UnboundTransaction,
  WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';
import type { WalletFacade, FacadeState, UnshieldedKeystore } from '@midnight-ntwrk/wallet-sdk';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import * as Rx from 'rxjs';
import type { Logger } from 'pino';
import { assembleWallet, type FastSyncOptions } from './fast-sync/fast-wallet.js';

export type WalletSecret =
  | { kind: 'seed'; value: string }
  | { kind: 'mnemonic'; value: string };

export class MidnightWalletProvider implements MidnightProvider, WalletProvider {
  readonly wallet: WalletFacade;
  readonly unshieldedKeystore: UnshieldedKeystore;

  private constructor(
    private readonly logger: Logger,
    wallet: WalletFacade,
    private readonly zswapSecretKeys: ZswapSecretKeys,
    private readonly dustSecretKey: DustSecretKey,
    unshieldedKeystore: UnshieldedKeystore,
  ) {
    this.wallet = wallet;
    this.unshieldedKeystore = unshieldedKeystore;
  }

  getCoinPublicKey(): CoinPublicKey {
    return this.zswapSecretKeys.coinPublicKey;
  }

  getEncryptionPublicKey(): EncPublicKey {
    return this.zswapSecretKeys.encryptionPublicKey;
  }

  async balanceTx(
    tx: UnboundTransaction,
    ttl: Date = ttlOneHour(),
  ): Promise<FinalizedTransaction> {
    const recipe = await this.wallet.balanceUnboundTransaction(
      tx,
      {
        shieldedSecretKeys: this.zswapSecretKeys,
        dustSecretKey: this.dustSecretKey,
      },
      { ttl },
    );
    return await this.wallet.finalizeRecipe(recipe);
  }

  submitTx(tx: FinalizedTransaction): Promise<string> {
    return this.wallet.submitTransaction(tx);
  }

  async start(): Promise<void> {
    this.logger.info('Starting wallet...');
    await this.wallet.start(this.zswapSecretKeys, this.dustSecretKey);
  }

  async stop(): Promise<void> {
    return this.wallet.stop();
  }

  /**
   * Build an un-started wallet provider. Pass `opts.fastSync` to pre-seed a
   * brand-new wallet from the shipped reference so it starts near chain tip
   * instead of walking the chain from genesis; omit it for a normal sync.
   *
   * The safety guard inside only seeds a wallet whose birthday is at or after the
   * reference height, so enabling fast-sync on a wallet with prior history is a
   * no-op (it falls back to a full sync) rather than a hazard.
   */
  static async build(
    logger: Logger,
    env: EnvironmentConfiguration,
    secret: WalletSecret,
    opts?: { fastSync?: FastSyncOptions },
  ): Promise<MidnightWalletProvider> {
    const { facade, zswapSecretKeys, dustSecretKey, keystore } = await assembleWallet(
      logger,
      env,
      secret,
      opts?.fastSync,
    );
    logger.info(`Wallet built from ${secret.kind}${opts?.fastSync ? ' (fast-sync enabled)' : ''}.`);
    return new MidnightWalletProvider(logger, facade, zswapSecretKeys, dustSecretKey, keystore);
  }
}

function isProgressStrictlyComplete(progress: unknown): boolean {
  if (!progress || typeof progress !== 'object') {
    return false;
  }
  const candidate = progress as { isStrictlyComplete?: unknown };
  if (typeof candidate.isStrictlyComplete !== 'function') {
    return false;
  }
  return (candidate.isStrictlyComplete as () => boolean)();
}

// Renders sync status as "<complete> (n/m)" where n is the applied index and
// m is the target the wallet must reach for isStrictlyComplete() to be true.
// Shielded/dust progress uses appliedIndex/highestRelevantWalletIndex; the
// unshielded wallet uses appliedId/highestTransactionId.
function formatProgress(progress: unknown): string {
  const complete = isProgressStrictlyComplete(progress);
  if (!progress || typeof progress !== 'object') {
    return `${complete}`;
  }
  const p = progress as {
    appliedIndex?: bigint;
    highestRelevantWalletIndex?: bigint;
    appliedId?: bigint;
    highestTransactionId?: bigint;
  };
  const applied = p.appliedIndex ?? p.appliedId;
  const target = p.highestRelevantWalletIndex ?? p.highestTransactionId;
  if (applied === undefined || target === undefined) {
    return `${complete}`;
  }
  return `${complete} (${applied}/${target})`;
}

export async function syncWallet(
  logger: Logger,
  wallet: WalletFacade,
  timeout = 300_000,
): Promise<FacadeState> {
  logger.info('Syncing wallet...');
  let emissionCount = 0;
  return Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.tap((state: FacadeState) => {
        emissionCount++;
        const shielded = isProgressStrictlyComplete(state.shielded.state.progress);
        const unshielded = isProgressStrictlyComplete(state.unshielded.progress);
        const dust = isProgressStrictlyComplete(state.dust.state.progress);
        logger.info(
          `Wallet sync [${emissionCount}]: shielded=${formatProgress(state.shielded.state.progress)}, ` +
            `unshielded=${formatProgress(state.unshielded.progress)}, dust=${formatProgress(state.dust.state.progress)}`,
        );
        if (!shielded) {
          logger.debug(`  shielded.progress: ${JSON.stringify(state.shielded.state.progress)}`);
        }
        if (!unshielded) {
          logger.debug(`  unshielded.progress: ${JSON.stringify(state.unshielded.progress)}`);
        }
        if (!dust) {
          logger.debug(`  dust.progress: ${JSON.stringify(state.dust.state.progress)}`);
        }
      }),
      Rx.filter(
        (state: FacadeState) =>
          isProgressStrictlyComplete(state.shielded.state.progress) &&
          isProgressStrictlyComplete(state.dust.state.progress) &&
          isProgressStrictlyComplete(state.unshielded.progress),
      ),
      Rx.tap(() => logger.info(`Wallet sync complete after ${emissionCount} emissions`)),
      Rx.timeout({
        each: timeout,
        with: () =>
          Rx.throwError(
            () => new Error(`Wallet sync timeout after ${timeout}ms (${emissionCount} emissions received)`),
          ),
      }),
      Rx.catchError((err) => {
        logger.error(`Wallet sync error: ${err}`);
        return Rx.throwError(() => err);
      }),
    ),
  );
}