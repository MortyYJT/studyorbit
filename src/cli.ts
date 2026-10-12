#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { CourseworkError } from './protocol/errors.js';
import { BrowserChoiceError } from './capture/browser.js';
import { parseProtocolCLI } from './protocol/cli.js';
import { createRegistry } from './protocol/registry.js';
import { unavailableCLIContext } from './protocol/cli-context.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command()
  .name('coursework')
  .description('Manage cited coursework tasks')
  .version(version);

program.command('capture')
  .description('Sign in manually and save local page snapshots')
  .option('--crawl', 'Run one selected-course capture')
  .option('--reselect', 'Refresh course selection in a terminal')
  .action(async (options: { crawl?: boolean; reselect?: boolean }) => {
    try {
      const { capture } = await import('./capture/command.js');
      await capture(options);
    } catch (error) {
      if (error instanceof CourseworkError && error.code === 'LOCKED') {
        console.error(error.message);
        process.exitCode = 3;
      } else if (error instanceof BrowserChoiceError) {
        console.error(error.message);
        process.exitCode = error.exitCode;
      } else {
        console.error('Capture failed. Check the browser installation and local profile are available.');
        process.exitCode = 1;
      }
    }
  });

if (process.argv[2] === 'quiz') {
  const { parseQuizCLI } = await import('./quiz/cli.js');
  await parseQuizCLI(process.argv.slice(2));
} else if (process.argv[2] === 'mcp' && process.argv.length === 3) {
  // stdout is reserved for MCP framing: route any stray console output to stderr.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  const { runMcpStdio } = await import('./protocol/mcp.js');
  await runMcpStdio({ registry: createRegistry(), context: unavailableCLIContext(), version });
} else if (['capture', '--version', '-V'].includes(process.argv[2] ?? '')) await program.parseAsync();
else await parseProtocolCLI(process.argv.slice(2), { registry: createRegistry(), context: unavailableCLIContext(), program });
