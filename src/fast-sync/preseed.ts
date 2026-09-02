// Key-swap a reference into a new wallet's serialized snapshots, and the safety
// guard that decides whether a wallet may be seeded at all.
//
// Ported from moth-wallet's packages/core/src/sync/preseed.ts. The reference
// holds public chain state plus a public key that gets replaced here; it carries
// no secret and no user-specific material, which is what makes it shippable.

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { DustSecretKey, ZswapSecretKeys } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { PublicKey } from '@midnight-ntwrk/wallet-sdk/unshielded';
import type { EmptyRefStates } from './reference-bundle.js';

/** The public identity of the wallet being seeded — the only per-wallet fields. */
export interface NewWalletKeys {
  shieldedSecretKeys: ZswapSecretKeys;
  unshieldedPublicKey: PublicKey;
  dustSecretKey: DustSecretKey;
}

export interface SeededSnapshots {
  shielded: string;
  unshielded: string;
  /** Absent if the dust snapshot could not be built; dust then syncs from genesis. */
  dust?: string;
}

/**
 * Produce the three swapped serialized snapshots to `restore()` a new wallet
 * from. Substitutes the new wallet's keys and keeps `state`, `protocolVersion`
 * and `offset` verbatim.
 *
 * - Shielded: reference's Zswap tree + cursor, new coin/encryption public keys.
 * - Unshielded: new public key, empty UTxOs, reference's transaction cursor.
 * - Dust: reference state as-is with the new dust public key swapped in. Dust
 *   ledger events are global (the indexer streams them by a chain-wide id) and a
 *   wallet holding no NIGHT has no designations of its own, so the reference's
 *   generation tree and cursor transfer directly. This is the expensive part to
 *   get right — without it dust walks the whole chain.
 *
 * Returns null on any parse failure, so the caller falls back to a full sync.
 */
export function preSeedNewWallet(
  keys: NewWalletKeys,
  networkId: string,
  emptyRef: EmptyRefStates,
): SeededSnapshots | null {
  try {
    setNetworkId(networkId);

    const refSh = JSON.parse(emptyRef.shielded) as Record<string, unknown>;
    const refUn = JSON.parse(emptyRef.unshielded) as Record<string, unknown>;
    const pk = keys.unshieldedPublicKey;

    const shieldedSnap: Record<string, unknown> = {
      publicKeys: {
        coinPublicKey: keys.shieldedSecretKeys.coinPublicKey,
        encryptionPublicKey: keys.shieldedSecretKeys.encryptionPublicKey,
      },
      state: refSh['state'],
      protocolVersion: refSh['protocolVersion'],
      networkId,
      coinHashes: {},
    };
    if (refSh['offset'] !== undefined) shieldedSnap['offset'] = refSh['offset'];

    const unshieldedSnap: Record<string, unknown> = {
      publicKey: { publicKey: pk.publicKey, addressHex: pk.addressHex, address: pk.address },
      state: { availableUtxos: [], pendingUtxos: [] },
      protocolVersion: refUn['protocolVersion'],
      networkId,
    };
    if (refUn['appliedId'] !== undefined) unshieldedSnap['appliedId'] = refUn['appliedId'];

    let dustSnap: string | undefined;
    try {
      const refDust = JSON.parse(emptyRef.dust) as Record<string, unknown>;
      // The dust public key is a bigint; snapshots store it as a decimal string
      // (JSON.stringify throws on a raw bigint) — hence the .toString().
      dustSnap = JSON.stringify({
        publicKey: { publicKey: keys.dustSecretKey.publicKey.toString() },
        state: refDust['state'],
        protocolVersion: refDust['protocolVersion'],
        networkId,
        offset: refDust['offset'],
      });
    } catch {
      // Dust preseed failure is non-fatal — dust syncs from genesis.
    }

    return {
      shielded: JSON.stringify(shieldedSnap),
      unshielded: JSON.stringify(unshieldedSnap),
      dust: dustSnap,
    };
  } catch {
    return null;
  }
}

/**
 * SAFETY GUARD — the single most important rule of pre-seeding.
 *
 * Only seed a wallet whose birthday (its creation height) is at or after the
 * reference's height. Seeding a wallet that could have been active earlier
 * starts it past its own history and silently hides those funds. A brand-new
 * wallet created "now" is safe; a wallet restored from a mnemonic, or one whose
 * birthday is unknown, is not — it must sync from genesis.
 *
 * A stale reference (older than the birthday) is only slower, never wrong.
 */
export function isSeedable(emptyRef: EmptyRefStates, birthday: number | undefined): boolean {
  return birthday !== undefined && emptyRef.height <= birthday;
}
