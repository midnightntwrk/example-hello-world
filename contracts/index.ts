import { CompiledContract } from '@midnight-ntwrk/compact-js';
import path from 'node:path';

export {
  Contract,
  ledger,
  pureCircuits,
  type Ledger,
  type Witnesses,
  type ImpureCircuits,
  type PureCircuits,
} from './managed/hello-world/contract/index.js';
import { witnesses } from './witnesses.js';
import { Contract } from './managed/hello-world/contract/index.js';

const currentDir = path.resolve(new URL(import.meta.url).pathname, '..');
export const zkConfigPath = path.resolve(currentDir, 'managed', 'hello-world');

export const CompiledHelloWorldContract = CompiledContract.make(
  'HelloWorldContract',
  Contract,
).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);
