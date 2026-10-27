#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { parseProtocolCLI } from './protocol/cli.js';
import { fail } from './protocol/envelope.js';
import { ExtensionBridge } from './sync/extension-bridge.js';
import { createProductionProtocol } from './protocol/production.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command()
  .name('coursework')
  .description('Manage cited coursework tasks')
  .version(version);

if (['--version', '-V'].includes(process.argv[2] ?? '')) await program.parseAsync();
else {
  const isMcp = process.argv[2] === 'mcp' && process.argv.length === 3;
  const isUi = process.argv[2] === 'ui' && process.argv.length === 3;
  program.command('ui').description('Open the local owner frontend');
  const isHttp = process.argv[2] === 'http' && process.argv.length === 3;
  if (isMcp) {
    // stdout is reserved for MCP framing, including during production initialization.
    console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  }
  // Syncs run in the UI and HTTP hosts; the MCP process only serves agent tools.
  const extension = isUi || isHttp ? new ExtensionBridge() : undefined;
  if (extension && !await extension.start()) process.stderr.write('coursework: extension bridge unavailable.\n');
  let host: ReturnType<typeof createProductionProtocol> | undefined;
  try { host = createProductionProtocol({ extension }); }
  catch {
    await extension?.close();
    process.exitCode = 1;
    process.stderr.write('coursework: production storage is unavailable.\n');
    if (!isMcp && !isHttp && !isUi) console.log(JSON.stringify(fail('unknown', 'INTERNAL', 'Production storage is unavailable.')));
  }
  if (host) try {
    if (isMcp) {
      const { runMcpStdio, sessionContext } = await import('./protocol/mcp.js');
      await runMcpStdio({ ...host, context: sessionContext(host.context), version });
    } else if (isUi) {
      const { serveProductionUI } = await import('./protocol/http-host.js');
      try { await serveProductionUI(host); }
      catch { process.exitCode = 1; process.stderr.write('coursework ui: frontend build or local HTTP host unavailable. Build dist/ui and retry.\n'); }
    } else if (isHttp) {
      const { serveProductionHttp } = await import('./protocol/http-host.js');
      await serveProductionHttp(host);
    } else await parseProtocolCLI(process.argv.slice(2), { ...host, program,
      result: async response => {
        return response;
      },
    });
  } finally { await extension?.close(); await host.close(); }
}
