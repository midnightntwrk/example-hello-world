// This file is part of example-hello-world.
// Copyright (C) 2025-2026 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractSourcePath = path.resolve(
  __dirname,
  '..',
  'contracts',
  'hello-world.compact',
);
const generatedContractPath = path.resolve(
  __dirname,
  '..',
  'contracts',
  'managed',
  'hello-world',
  'contract',
  'index.js',
);

export function ensureCompiledArtifacts() {
  if (!fs.existsSync(contractSourcePath)) {
    throw new Error(
      'Missing contracts/hello-world.compact. Restore the contract source before compiling.',
    );
  }

  if (!fs.existsSync(generatedContractPath)) {
    throw new Error(
      'Missing compiled contract artifacts. Run `npm run compile` before `npm run build`, `npm run deploy`, or `npm run cli`.',
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    ensureCompiledArtifacts();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
