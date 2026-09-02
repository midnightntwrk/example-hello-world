// Load a pre-built pre-seed reference bundle shipped with this repo.
//
// A reference is an empty throwaway wallet synced to chain tip once, then
// serialized. New wallets restore from it (with their own keys swapped in)
// instead of walking the chain from genesis — turning a ~78-minute preprod
// first sync into seconds. See docs/FAST-SYNC.md.
//
// The bundle format matches what moth-wallet's `scripts/export-preseed.mjs`
// writes: one gzipped serialized state per sub-wallet plus a manifest recording
// the chain height and a witness per cursor-bearing part.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** A reference's three serialized sub-wallet states plus the height it holds. */
export interface EmptyRefStates {
  shielded: string;
  unshielded: string;
  dust: string;
  /**
   * Chain height this reference was synced to. A wallet may only be seeded from
   * it when the wallet's birthday is at or after this height — otherwise the
   * reference starts the wallet past its own history and hides earlier funds.
   * This is a block height; a snapshot's `offset` is an event index — never
   * compare the two.
   */
  height: number;
}

interface BundleManifest {
  network: string;
  height: number;
  parts: Record<string, { bytes: number; gzipBytes: number }>;
  witnesses?: Record<string, { stream: string; id: number; digest: string }>;
}

const PARTS = ['shielded', 'unshielded', 'dust'] as const;

/**
 * The applied-index a serialized snapshot resumes from. `offset === 0` is the
 * SDK's "stream from genesis" sentinel, so a reference whose dust or shielded
 * offset is 0 seeds nothing however complete the rest looks.
 */
function snapshotOffset(raw: string): bigint {
  try {
    const parsed = JSON.parse(raw) as { offset?: string | number };
    return parsed.offset === undefined ? 0n : BigInt(parsed.offset);
  } catch {
    return 0n;
  }
}

/**
 * Read the reference for `networkId` from `<referenceRoot>/<networkId>/`.
 *
 * Returns null — a full genesis sync — rather than throwing, for every failure:
 * no bundle for this network, a corrupt file, a network mismatch, a missing
 * height, or a genesis-offset cursor. Failing closed means a packaging problem
 * costs a slow sync, never a wallet seeded from half a reference.
 */
export function loadReferenceBundle(referenceRoot: string, networkId: string): EmptyRefStates | null {
  const dir = join(referenceRoot, networkId);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;

  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest;
  } catch {
    return null;
  }
  if (manifest.network !== networkId) return null;
  if (!Number.isFinite(manifest.height) || manifest.height <= 0) return null;

  const states: Partial<Record<(typeof PARTS)[number], string>> = {};
  for (const part of PARTS) {
    const file = join(dir, `${part}.dat.gz`);
    if (!existsSync(file)) return null;
    try {
      states[part] = gunzipSync(readFileSync(file)).toString('utf8');
    } catch {
      return null;
    }
  }

  const shielded = states.shielded;
  const unshielded = states.unshielded;
  const dust = states.dust;
  if (!shielded || !unshielded || !dust) return null;

  // A reference whose dust/shielded cursor is 0 would seed a genesis stream.
  if (snapshotOffset(dust) <= 0n || snapshotOffset(shielded) <= 0n) return null;

  return { shielded, unshielded, dust, height: manifest.height };
}
