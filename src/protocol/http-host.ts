import { dataDir } from '../config/data-dir.js';
import { startHttpTransport } from './http.js';
import type { createProductionProtocol } from './production.js';
/** Host bootstrap details are stderr-only; the secret itself is never printed. */
export async function serveProductionHttp(host: Pick<ReturnType<typeof createProductionProtocol>, 'registry' | 'context'>): Promise<void> {
  const transport = await startHttpTransport({ registry: host.registry, context: host.context, capabilityDirectory: dataDir() });
  process.stderr.write(`coursework http: ${transport.origin}\nCapability file: ${transport.capabilityFile}\n`);
  try {
    await new Promise<void>(resolve => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  } finally { await transport.close(); }
}
