# Fast sync (pre-seed)

> ⚠️ **Development wallets only — not recommended for mainnet wallets with real
> funds.** Fast-sync is designed for the freshly generated, throwaway testnet
> wallets this suite creates. A wallet that already holds funds (any mainnet
> wallet, or any wallet restored from a seed/mnemonic) must sync from genesis;
> seeding it starts it past its own history and **silently hides funds**. The
> `isSeedable()` guard refuses such wallets, but do not attempt to bypass it. See
> [Safety](#safety--read-this-before-trusting-it) below.

A brand-new wallet on preprod takes **~78 minutes** to sync for the first time.
Almost none of that is your transactions — it is DUST: the wallet has to build a
chain-wide generation tree by streaming ~1.4M global ledger events before it can
report a balance. Every new account pays it, on every device.

This repo **pre-seeds** new wallets. A throwaway empty wallet is synced to chain
tip once, its state is serialized into a **reference bundle** shipped under
`preseed/`, and every fresh wallet `restore()`s from that bundle (with its own keys
swapped in) instead of walking the chain from genesis.

The technique, and the safety rules that make it safe, come from moth-wallet's
field guide: `docs/patterns/preseed-sync-acceleration.md` in that repo. This is a
faithful, self-contained port onto the SDK's `restore()` API — it does **not**
depend on moth-wallet.

## It runs under the standard test script

There is no separate demo command — fast-sync is the default path in
`MidnightWalletProvider.build`, so `yarn test:preprod` (or `test:preview`) uses it:

1. The suite **generates a fresh wallet** (persisted, gitignored, under
   `.fast-sync-wallets/<network>.json`) and records its birthday — the chain tip at
   creation — so the safety guard can trust it.
2. The wallet **fast-syncs** from the shipped reference.
3. Because a fresh wallet holds no NIGHT, the suite **prints its address and the
   faucet URL and pauses** — `waitForFunds` polls until you fund it — then registers
   for DUST and runs the deploy/call tests.

```bash
yarn test:preview     # small reference, quick
yarn test:preprod     # the headline network
```

This is the standard developer entry point: you create a wallet, it syncs in
seconds, you fund it once, and the wallet is cached for later runs. Requires network
access to the indexer and node.

**Fallback for a wallet with history.** If you set `MIDNIGHT_<NET>_SEED` or
`MIDNIGHT_<NET>_MNEMONIC` in `.env.<network>`, the suite uses that wallet with a
normal full sync instead. Fast-sync cannot safely seed a wallet that predates the
reference (it would skip that wallet's own DUST registration and hide its funds), so
the guard refuses it — this fallback exists precisely for that case.

### What a run proves

The first sync emission shows each sub-wallet's `appliedIndex` starting at the
**reference cursor**, not 0. Verified on preview (reference at height 519,470):

```
seeded=[shielded,unshielded,dust] referenceHeight=519470
Wallet sync [1]: shielded=false (141061/…), unshielded=false (0/0), dust=false (141062/…)
```

Dust began at event **141,062** instead of 0 — skipping ~79% of the event stream
— then caught up to tip and reached fully-synced with no errors.

### Measured: preprod, fresh wallet

| phase | time |
|---|---|
| key derivation + gunzip + key-swap | ~0.7s |
| **`dust.restore()`** — deserialize the ~10.9 MB generation tree into WASM | **~72s** |
| sync catch-up (indexer, ~21.8k stale events) | ~53s |
| **total** | **~126s** |
| baseline, no reference | ~78 min |

**~37× faster**, but note where the time goes on preprod: not the network — the
long pole is `dust.restore()` deserializing the large global generation tree into
WASM. That cost scales with chain length (the tree), not with staleness, and it is
inherent to loading a reference of this size; it is not reducible from outside the
SDK. It shrinks to seconds on smaller chains (preview's dust state is ~260 KB, so
its restore is sub-second and a seeded preview wallet syncs in well under a minute).
Set `LOG_LEVEL=debug` to see the per-phase `[timing]` breakdown.

## How it works

| file | role |
|---|---|
| `src/fast-sync/reference-bundle.ts` | Load + validate a shipped reference (fail-closed to a full sync). |
| `src/fast-sync/preseed.ts` | Key-swap the reference into a new wallet's snapshots; the `height <= birthday` safety guard. |
| `src/fast-sync/dedup.ts` | Client-side workaround for an SDK boundary-event off-by-one that a catch-up sync would otherwise trip. |
| `src/fast-sync/fast-wallet.ts` | `assembleWallet` — build a `WalletFacade` from `restore()`d sub-wallets (mirrors testkit's `WalletFactory`); the engine behind `MidnightWalletProvider.build`. |
| `src/fast-sync/test-wallet.ts` | Get-or-create the persisted fresh wallet and record its birthday. |
| `src/wallet.ts` → `MidnightWalletProvider.build(…, { fastSync })` | The standard entry point; pass `fastSync` to pre-seed. |
| `preseed/<network>/` | The shipped reference bundles (`manifest.json` + gzipped state per sub-wallet). |

The reference contains **no secret and no user-specific data** — it is public
chain state plus a public key that gets replaced — which is what makes it safe to
ship in the repo.

## Safety — read this before trusting it

Pre-seeding done wrong **silently hides funds**. The one rule that prevents it:

> Only seed a wallet whose **birthday** (its creation height) is at or after the
> reference's height. Seeding a wallet that could have been active earlier starts
> it past its own history, and those coins never get scanned.

`isSeedable()` enforces this. The demo generates a fresh random wallet whose
birthday is the current chain tip, so seeding is always safe. A wallet **restored
from a mnemonic** must never be seeded — it may hold funds at any height and has to
sync from genesis. The guard also refuses when the chain tip cannot be read (no
birthday to compare), falling back to a full sync. See
`preseed/../docs/patterns/preseed-sync-acceleration.md` (moth-wallet) for the full
set of rules and the reasoning.

## Caveats

- **This is an interim technique.** It depends on the shape of the SDK's
  serialized sub-wallet state (JSON with `publicKeys`/`publicKey`, `state`,
  `protocolVersion`, `offset`), which is not a public contract and can change
  between SDK releases. Every failure path falls back to a normal sync, so an SDK
  bump costs time, never correctness. It retires when the wallet-sdk consumes the
  indexer's collapsed-update endpoints.
- **The shipped reference goes stale.** A stale reference is only slower, never
  wrong — the wallet syncs forward from it (~½ second of catch-up per hour of age).
  The preview bundle here is deliberately old; re-cut a bundle
  (moth-wallet's `scripts/export-preseed.mjs`) before relying on the numbers.
- **Reference size grows with the chain.** The preprod dust state is ~5 MB
  gzipped and will keep growing; mainnet's will be largest.
