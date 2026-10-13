#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { parseProtocolCLI } from './protocol/cli.js';
import { createRegistry } from './protocol/registry.js';
import { browserCLIContext, browserCLIExitCode } from './browser/runtime.js';
import { unavailableCLIContext } from './protocol/cli-context.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command()
  .name('coursework')
  .description('Manage cited coursework tasks')
  .version(version);

if (process.argv[2] === 'mcp' && process.argv.length === 3) {
  // stdout is reserved for MCP framing: route any stray console output to stderr.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  const { runMcpStdio } = await import('./protocol/mcp.js');
  await runMcpStdio({ registry: createRegistry(), context: browserCLIContext(unavailableCLIContext()), version });
} else if (['--version', '-V'].includes(process.argv[2] ?? '')) await program.parseAsync();
else await parseProtocolCLI(process.argv.slice(2), { registry: createRegistry(), context: browserCLIContext(unavailableCLIContext()), program,
  result: async response => {
    if (response.command.startsWith('browser.')) process.exitCode = browserCLIExitCode(response);
    return response;
  },
});
