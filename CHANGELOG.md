# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Move to the ledger 9 SDK: `wallet-sdk` 2.0.0 and `midnight-js` 5.0.0 (era-named `v9` imports, era-aware testkit wallet provider, new `config` provider block).
- Compile with `compact` 0.36.0 and a `>= 0.23` pragma (CI, README).
- Local stack: proof server 9.0.0, indexer 4.3.800, node 2.1.0-rc.4.
- Pin `effect` to one version to avoid a duplicate Effect runtime.

### Added

- Skip the ledger 8 dust history on a fresh start (`MIDNIGHT_FULL_DUST_HISTORY=1` to opt out).
