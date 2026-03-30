import { type WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { type Ledger } from './managed/hello-world/contract/index.js';

export type HelloWorldPrivateState = {
};

export const createHelloWorldPrivateState = (
): HelloWorldPrivateState => ({});

export const witnesses = {
  localSk: ({
    privateState,
  }: WitnessContext<Ledger, HelloWorldPrivateState>): [
    HelloWorldPrivateState,
  ] => {
    return [privateState];
  },
};
