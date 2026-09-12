// A robust submission service for remote networks.
//
// The SDK's default node client (makeDefaultSubmissionService) opens a WebSocket,
// immediately disconnects it to load metadata, then reconnects per-submit and
// waits for `Finalized`. Against a public preprod/preview node that connect/
// reconnect churn races the in-flight `author_submitAndWatchExtrinsic`
// subscription: the provider tears the socket down ("1000 Normal Closure") before
// the extrinsic is broadcast, so the transaction never reaches the mempool and
// the submit rejects. This surfaced as a `SubmissionError: Transaction submission
// error` during the NIGHT→DUST registration in the preprod funding gate.
//
// This service instead holds ONE persistent connection (opened lazily on the
// first submit, so facade init still touches no node — sync uses the indexer)
// and resolves as soon as the transaction is `InBlock`, which is all that is
// required for the registration to take effect. `waitForDust` remains the real
// success signal downstream.

import { ApiPromise, WsProvider } from '@polkadot/api';
import { u8aToHex } from '@polkadot/util';
import type { ISubmittableResult } from '@polkadot/types/types';
import type { FinalizedTransaction } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { SubmissionEvent, type SubmissionService } from '@midnight-ntwrk/wallet-sdk/capabilities/submission';
import { SerializedTransaction } from '@midnight-ntwrk/wallet-sdk-abstractions';
import type { Logger } from 'pino';

/**
 * A submission service that keeps a single persistent node connection and waits
 * only for `InBlock`. Preserves the lazy-connect property: no socket is opened
 * until the first `submitTransaction` call.
 */
export function robustSubmissionService(
  relayURL: URL,
  logger: Logger,
): SubmissionService<FinalizedTransaction> {
  let apiP: Promise<ApiPromise> | undefined;

  const getApi = (): Promise<ApiPromise> =>
    (apiP ??= ApiPromise.create({
      provider: new WsProvider(relayURL.toString()),
      throwOnConnect: true,
      noInitWarn: true,
    }));

  const submit = async (tx: FinalizedTransaction): Promise<SubmissionEvent> => {
    const api = await getApi();
    const serialized = SerializedTransaction.from(tx);
    const hex = u8aToHex(serialized);
    return await new Promise<SubmissionEvent>((resolve, reject) => {
      let unsub: (() => void) | undefined;
      const finish = (fn: () => void): void => {
        try {
          unsub?.();
        } catch {
          /* ignore */
        }
        fn();
      };

      // The node exposes the Midnight transaction as an unsigned extrinsic
      // carrying the already-signed/proved transaction bytes, so `.send()` (no
      // signer) is correct — the same call the SDK node client makes.
      void api.tx['midnight']!['sendMnTransaction']!(hex)
        .send((result: ISubmittableResult) => {
          const status = result.status;
          const txHash = result.txHash.toString();
          if (status.isInBlock || status.isFinalized) {
            const blockHash = (status.isInBlock ? status.asInBlock : status.asFinalized).toString();
            void api.rpc.chain
              .getHeader(blockHash)
              .then((header) => header.number.toBigInt())
              .catch(() => 0n)
              .then((blockHeight) => {
                const event = (status.isInBlock ? SubmissionEvent.InBlock : SubmissionEvent.Finalized)({
                  blockHash: blockHash as `0x${string}`,
                  blockHeight,
                  tx: serialized,
                  txHash: txHash as `0x${string}`,
                });
                finish(() => resolve(event as SubmissionEvent));
              });
          } else if (status.isInvalid || status.isDropped || status.isUsurped || status.isFinalityTimeout) {
            finish(() => reject(new Error(`Transaction ${status.type}: ${status.toString()}`)));
          } else {
            logger.debug(`Submission status: ${status.type}`);
          }
        })
        .then((u: () => void) => {
          unsub = u;
        })
        .catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
    });
  };

  return {
    submitTransaction: ((tx: FinalizedTransaction) => submit(tx)) as SubmissionService<FinalizedTransaction>['submitTransaction'],
    close: async (): Promise<void> => {
      if (apiP) {
        const api = await apiP.catch(() => undefined);
        await api?.disconnect();
      }
    },
  };
}
