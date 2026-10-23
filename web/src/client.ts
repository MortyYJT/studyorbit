import { z } from 'zod';
import { contracts, browserContracts, FailureEnvelopeSchema } from '../../src/protocol/contracts.js';
import { syncContracts } from '../../src/protocol/sync.js';
import { planningContracts, settingsInput } from '../../src/planning/contracts.js';
import { metricsContracts } from '../../src/metrics/contracts.js';

const commands = {
  'courses.list': contracts['courses.list'],
  'tasks.list': contracts['tasks.list'],
  'audit.list': contracts['audit.list'],
  ...browserContracts,
  ...syncContracts,
  'planning.settings.read': planningContracts['planning.settings.read'],
  'planning.settings.set': { input: settingsInput, output: z.strictObject({ recorded: z.literal(true), id: z.string().optional() }) },
  ...metricsContracts,
} as const;
export type Command = keyof typeof commands;
export type Output<N extends Command> = z.output<(typeof commands)[N]['output']>;
export class ClientError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function takeOwnerSession(location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>): string | undefined {
  const value = new URLSearchParams(location.hash.slice(1)).get('s');
  // Clear even malformed credentials before rendering or starting requests.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
const meta = z.strictObject({ runId: z.uuid(), durationMs: z.number().nonnegative() });
const writes = new Set<Command>(['sync.run', 'browser.start', 'browser.stop', 'browser.signin', 'planning.settings.set']);
export function createClient(initialSecret?: string, fetcher: typeof fetch = fetch) {
  let secret = initialSecret;
  return {
    hasSession: () => secret !== undefined,
    async call<N extends Command>(name: N, input: z.input<(typeof commands)[N]['input']>): Promise<Output<N>> {
      if (writes.has(name) && !secret) throw new ClientError('OWNER_SESSION_EXPIRED', 'Reopen with coursework ui.');
      const parsed = commands[name].input.parse(input);
      const response = await fetcher(`/api/${name}`, { method: 'POST', cache: 'no-store', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Coursework-Session': secret } : {}) }, body: JSON.stringify(parsed) });
      // HTTP rejects credentials before dispatch, so the failure's command is "unknown".
      if (response.status === 403 && secret) {
        secret = undefined;
        throw new ClientError('OWNER_SESSION_EXPIRED', 'Reopen with coursework ui.');
      }
      const schema = z.union([z.strictObject({ protocol: z.literal('coursework.agent/v1'), command: z.literal(name),
        meta, ok: z.literal(true), data: commands[name].output }), FailureEnvelopeSchema.refine(value => value.command === name)]);
      let raw: unknown;
      try { raw = await response.json(); } catch { throw new ClientError('INVALID_RESPONSE', 'Invalid server response'); }
      const result = schema.safeParse(raw);
      if (!result.success || result.data.ok && !response.ok) throw new ClientError('INVALID_RESPONSE', 'Invalid server response');
      if (!result.data.ok) throw new ClientError(result.data.error.code, result.data.error.message);
      return result.data.data as Output<N>;
    },
  };
}
export type Client = ReturnType<typeof createClient>;
