import { z } from 'zod';
import { hash } from '../citations/exact.js';
import type { ToolScope } from '../browser/tools/ports.js';
import type { BrowserTools } from '../browser/tools/service.js';
import { toolContracts, confirmationInput } from '../browser/tools/contracts.js';
import type { AgentTool } from '../agent/adapter.js';
import { safeError, type Registry } from './registry.js';
import { fail } from './envelope.js';
import { CourseworkError } from './errors.js';

export function browserAgentTools(service: BrowserTools): AgentTool[] {
  return Object.entries(toolContracts).map(([name, contract]) => ({ name, description: name,
    recordsSteps: true, inputSchema: z.toJSONSchema(contract.input), execute: async (input, scope) => {
      try { return await service.execute(name, input, scope); }
      catch (error) { const safe = safeError(error, name); return fail(name, safe.code, safe.message, safe.next); }
    } }));
}
export function registerBrowserTools(registry: Registry, service?: BrowserTools, scope?: () => ToolScope) {
  const available = () => { if (!service) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Browser tools unavailable.'); return service; };
  for (const [name, contract] of Object.entries(toolContracts)) registry.register<z.ZodType, z.ZodType>({ name, ...contract, selfAudited: true,
    handler: input => available().execute(name, input, scope?.()) });
  registry.register({ name: 'confirmation.decide', input: confirmationInput, output: z.strictObject({ recorded: z.literal(true) }), level: 0, authority: 'owner-session',
    handler: async (input, context) => { await available().decide(input.confirmationId, input.decision, context.owner); return { recorded: true as const }; } });
  registry.register({ name: 'confirmation.list', input: z.strictObject({ limit: z.number().int().min(1).max(50).default(20), cursor: z.string().max(512).optional() }),
    output: z.object({ items: z.array(z.json()), nextCursor: z.string().optional() }), level: 0, authority: 'owner-session', handler: input => {
      const rows = available().pending(); const digest = hash(rows.map(r => r.id)); let offset = 0;
      if (input.cursor) {
        const match = /^(\d+):([a-f0-9]{64})$/.exec(input.cursor);
        if (!match || match[2] !== digest || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) >= rows.length) throw new CourseworkError('INVALID_INPUT', 'Invalid confirmation cursor.');
        offset = Number(match[1]);
      }
      const next = offset + input.limit;
      return { items: rows.slice(offset, next), ...(next < rows.length ? { nextCursor: `${next}:${digest}` } : {}) };
    } });
  registry.register({ name: 'browser.view', input: z.strictObject({ tabId: z.string().uuid() }), output: z.strictObject({ focused: z.literal(true) }), level: 0, authority: 'owner-session',
    handler: async (input, context) => { await available().focus(input.tabId, context.owner); return { focused: true as const }; } });
}
