#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { CliUsageError } from './args.ts';
import { EXIT_CODES, CliRuntimeError } from './output.ts';
import { main } from './main.ts';

main(process.argv.slice(2))
  .then((outcome) => { process.exitCode = outcome.exitCode; })
  .catch((error: unknown) => {
    if (error instanceof CliUsageError || error instanceof CliRuntimeError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = EXIT_CODES.general;
  });
