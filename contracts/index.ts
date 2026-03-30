import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { type WitnessContext } from '@midnight-ntwrk/compact-runtime';
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

import { Contract, type Ledger } from './managed/hello-world/contract/index.js';

export type HelloWorldPrivateState = {
};

export const createHelloWorldPrivateState = (
): HelloWorldPrivateState => ({});

const witnesses = {
  localSk: ({
    privateState,
  }: WitnessContext<Ledger, HelloWorldPrivateState>): [
    HelloWorldPrivateState,
  ] => {
    return [privateState];
  },
};

const currentDir = path.resolve(new URL(import.meta.url).pathname, '..');
export const zkConfigPath = path.resolve(currentDir, 'managed', 'hello-world');

export const CompiledHelloWorldContract = CompiledContract.make(
  'HelloWorldContract',
  Contract,
).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);
