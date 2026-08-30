import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import path from 'node:path';

export {
  Contract,
  ledger,
  pureCircuits,
  type Ledger,
  type ImpureCircuits,
  type PureCircuits,
} from './managed/mindvault/contract/index.js';

import { Contract } from './managed/mindvault/contract/index.js';

const currentDir = path.resolve(new URL(import.meta.url).pathname, '..');

export const zkConfigPath = path.resolve(
  currentDir,
  'managed',
  'mindvault',
);

export const CompiledMindVaultContract = CompiledContract.make(
  'MindVaultContract',
  Contract,
).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);
