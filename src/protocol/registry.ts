import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { contracts, ownerCommands, FailureEnvelopeSchema, type Level, type CommandName } from './contracts.js';
import type { TrustedContext, ReadCommand, WriteCommand, AuditEvent } from './context.js';
import { ok, fail, withMetadata, type Envelope } from './envelope.js';
import { CourseworkError, retryable, type ErrorCode } from './errors.js';

export type Handler<I = unknown, O = unknown> = (input: I, context: TrustedContext) => O | Promise<O>;
export interface RegistryEntry<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string; input: I; output: O; handler: Handler<z.output<I>, z.output<O>>; level: Level;
}
export class Registry {
  private readonly entries = new Map<string, RegistryEntry>();
  register<I extends z.ZodType, O extends z.ZodType>(entry: RegistryEntry<I, O>): void {
    if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/.test(entry.name) || this.entries.has(entry.name)) {
      throw new CourseworkError('INVALID_INPUT', 'Invalid or duplicate command registration.');
    }
    // Snapshot/freeze registration so discovery and dispatch cannot drift via caller mutation.
    this.entries.set(entry.name, Object.freeze({ ...entry }) as RegistryEntry);
  }
  get(name: string): RegistryEntry | undefined { return this.entries.get(name); }
  list(): readonly RegistryEntry[] { return [...this.entries.values()]; }
}
const safeMessages: Record<ErrorCode, string> = {
  INVALID_INPUT: 'Invalid input or required trusted authorization is unavailable.',
  NOT_FOUND: 'The command or requested record was not found.', CONFLICT: 'The target revision changed; refresh before retrying.',
  AUTH_EXPIRED: 'Authentication expired.', SOURCE_UNAVAILABLE: 'The required source or adapter is unavailable.',
  LOCKED: 'The target is locked.', CITATION_MISMATCH: 'Citation provenance could not be verified.',
  LIMIT_EXCEEDED: 'The response exceeds 64 KiB.', INTERNAL: 'The command could not complete safely.',
};
function safeError(error: unknown): CourseworkError {
  const code = error instanceof CourseworkError && Object.hasOwn(retryable, error.code) ? error.code : 'INTERNAL';
  return new CourseworkError(code, safeMessages[code]);
}
/** Explicitly adapt legacy envelopes; ordinary command data is never duck-typed as an envelope. */
export function adaptLegacyHandler(handler: Handler<unknown, Envelope>): Handler {
  return async (input, context) => {
    const result = await handler(input, context);
    if (!result.ok) {
      const parsed = FailureEnvelopeSchema.safeParse(result);
      if (!parsed.success) throw new CourseworkError('INTERNAL', safeMessages.INTERNAL);
      throw new CourseworkError(parsed.data.error.code, safeMessages[parsed.data.error.code]);
    }
    if (result.protocol !== 'coursework.agent/v1') throw new CourseworkError('INTERNAL', safeMessages.INTERNAL);
    return result.data;
  };
}
/** Trusted context is a separate host argument and is never reconstructed from the request. */
export async function dispatch(registry: Registry, name: string, input: unknown, context: TrustedContext): Promise<Envelope> {
  const runId = randomUUID(); const started = performance.now(); let executed = false;
  // Do not let oversized/invalid names inject request prose into the metadata journals.
  const safeName = registry.get(name)?.name ?? 'unknown';
  const record = async (phase: AuditEvent['phase'], code: AuditEvent['code']) => {
    const event = { command: safeName, runId, phase, code };
    await context.audit.record(event); await context.runs.record(event);
  };
  let result: Envelope;
  try {
    const entry = registry.get(name);
    if (!entry) throw new CourseworkError('NOT_FOUND', safeMessages.NOT_FOUND);
    const parsed = entry.input.safeParse(input);
    if (!parsed.success) throw new CourseworkError('INVALID_INPUT', safeMessages.INVALID_INPUT);
    if (ownerCommands.has(name)) {
      if (!context.owner) throw new CourseworkError('INVALID_INPUT', safeMessages.INVALID_INPUT);
      await context.owner.assertOwner(name);
    }
    await context.authorization.check(name, entry.level, parsed.data);
    if (entry.level >= 1 && name in contracts) await context.evidence.check(name as CommandName, parsed.data);
    await record('intent', 'OK');
    executed = true;
    const raw = await entry.handler(parsed.data, context);
    const validated = entry.output.safeParse(raw);
    if (!validated.success) throw new CourseworkError('INTERNAL', safeMessages.INTERNAL);
    const protectedOutput = await context.privacy.protect(name, validated.data);
    const finalOutput = entry.output.safeParse(protectedOutput);
    if (!finalOutput.success) throw new CourseworkError('INTERNAL', safeMessages.INTERNAL);
    result = withMetadata(ok(safeName, finalOutput.data), { runId, durationMs: performance.now() - started });
    await record('outcome', result.ok ? 'OK' : result.error.code);
  } catch (error) {
    let failure = safeError(error);
    try { await record(executed ? 'outcome' : 'denial', failure.code); }
    catch { failure = new CourseworkError('INTERNAL', safeMessages.INTERNAL); }
    result = withMetadata(fail(safeName, failure.code, failure.message, failure.next), { runId, durationMs: performance.now() - started });
  }
  return result;
}
const readNames = new Set<string>(Object.keys(contracts).filter(n => n.endsWith('.list')).concat(['sources.get', 'proposals.get', 'changes', 'quiz.read']));
/** Bind the settled contract surface to injected ports; no production service is selected here. */
export function createRegistry(): Registry {
  const registry = new Registry();
  const handlers = new Map<string, Handler>();
  for (const name of Object.keys(contracts) as CommandName[]) {
    const canonical = name === 'quiz.policy' ? 'policy.record' : name === 'quiz.grant' ? 'grant.record' : name;
    let handler = handlers.get(canonical);
    if (!handler) {
      handler = async (input, context) => {
        if (canonical === 'quiz.fill') return context.actions
          ? context.actions.fill(input as never, context) : { status: 'unavailable', reason: 'SOURCE_UNAVAILABLE' };
        if (canonical === 'quiz.submit') return context.actions
          ? context.actions.submit(input as never, context) : { status: 'unavailable', reason: 'SOURCE_UNAVAILABLE' };
        if (readNames.has(canonical)) return context.repository.read(canonical as ReadCommand, input as never);
        return context.services.write(canonical as WriteCommand, input as never, context);
      };
      handlers.set(canonical, handler);
    }
    const contract = contracts[name];
    registry.register<z.ZodType, z.ZodType>({ name, ...contract, handler });
  }
  return registry;
}
