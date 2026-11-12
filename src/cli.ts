#!/usr/bin/env bun
import { runCli } from './queue.ts';

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  console.error(`nightq: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
