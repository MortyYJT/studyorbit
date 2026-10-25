import { z } from 'zod';
import { contracts, FailureEnvelopeSchema } from '../../src/protocol/contracts.js';
import { syncContracts } from '../../src/protocol/sync.js';
import { planningContracts, planningInputs, settingsInput } from '../../src/planning/contracts.js';
import { annotationCommands, autonomyCommands, autonomyReads, workCommands } from './course-contracts.js';
import { memoryContracts } from '../../src/memory/contracts.js';
import { metricsContracts } from '../../src/metrics/contracts.js';

const commands = {
  'courses.list': contracts['courses.list'],
  'tasks.list': contracts['tasks.list'],
  'audit.list': contracts['audit.list'],
  ...syncContracts,
  'planning.settings.read': planningContracts['planning.settings.read'],
  'planning.settings.set': { input: settingsInput, output: z.strictObject({ recorded: z.literal(true), id: z.string().optional() }) },
  // K2
  'assessments.list': contracts['assessments.list'],
  'plan.read': planningContracts['plan.read'],
  ...recorded('plan.start.set'), ...recorded('plan.start.clear'), ...recorded('time.record'),
  ...recorded('manual.create'), ...recorded('manual.edit'), ...recorded('manual.complete'), ...recorded('manual.delete'),
  ...metricsContracts,
  ...memoryContracts,
  // K3 course page
  'sources.get': contracts['sources.get'], 'revision.read': contracts['revision.read'],
  'revision.list': contracts['revision.list'], 'practice.stats': contracts['practice.stats'],
  ...annotationCommands, ...autonomyCommands, ...autonomyReads, ...workCommands,
} as const;
function recorded<N extends 'plan.start.set' | 'plan.start.clear' | 'time.record' | 'manual.create' | 'manual.edit' | 'manual.complete' | 'manual.delete'>(name: N) {
  return { [name]: { input: planningInputs[name], output: z.strictObject({ recorded: z.literal(true), id: z.string().optional() }) } } as
    { [K in N]: { input: (typeof planningInputs)[K]; output: z.ZodObject<{ recorded: z.ZodLiteral<true>; id: z.ZodOptional<z.ZodString> }, z.core.$strict> } };
}
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
// Commands that need the owner session.
const writes = new Set<Command>(['memory.add', 'memory.edit', 'memory.delete', 'sync.run', 'courses.select', 'planning.settings.set',
  'plan.start.set', 'plan.start.clear', 'time.record', 'manual.create', 'manual.edit', 'manual.complete', 'manual.delete',
  'annotation.confirm', 'annotation.replace', ...Object.keys(autonomyCommands) as Command[], ...Object.keys(workCommands) as Command[]]);
export function createClient(initialSecret?: string, fetcher: typeof fetch = fetch) {
  let secret = initialSecret;
  return {
    hasSession: () => secret !== undefined,
    /** Owner-session request for routes outside the command envelope map (agent chat). */
    async raw(path: string, init: RequestInit = {}): Promise<Response> {
      if (!secret) throw new ClientError('OWNER_SESSION_EXPIRED', 'Reopen with coursework ui.');
      const response = await fetcher(path, { ...init, cache: 'no-store', credentials: 'omit', headers: { ...init.headers as Record<string, string>, 'X-Coursework-Session': secret } });
      if (response.status === 403) { secret = undefined; throw new ClientError('OWNER_SESSION_EXPIRED', 'Reopen with coursework ui.'); }
      return response;
    },
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
