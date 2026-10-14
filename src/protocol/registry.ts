import { autonomyContracts, type AssessmentAutonomy } from './autonomy.js';
import { safeBrowserChoiceMessage } from '../capture/browser.js';
import { browserStatus, type BrowserStatus } from '../browser/status.js';
import { ownerResidentBrowser } from '../browser/runtime.js';
import type { BrowserState } from '../browser/resident.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { contracts, browserContracts, ownerCommands, FailureEnvelopeSchema, type Level, type CommandName } from './contracts.js';
import type { TrustedContext, ReadCommand, WriteCommand, AuditEvent } from './context.js';
import { ok, fail, withMetadata, type Envelope } from './envelope.js';
import { CourseworkError, retryable, type ErrorCode } from './errors.js';

export type Handler<I = unknown, O = unknown> = (input: I, context: TrustedContext) => O | Promise<O>;
export interface RegistryEntry<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string; input: I; output: O; handler: Handler<z.output<I>, z.output<O>>; level: Level;
  /** Extensions declare owner gates here; transport adapters share this classification. */
  authority?: 'agent' | 'owner' | 'owner-session';
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
  agentTools(base: TrustedContext): { registry: Registry; context: AgentContext } {
    const registry = new Registry();
    for (const entry of this.list()) if (!isOwnerCommand(entry) && !['sync.run', 'audit.record'].includes(entry.name)) registry.register(entry);
    const { owner: _owner, ...ports } = base;
    const context: AgentContext = Object.freeze(ports);
    return { registry, context };
  }
  get(name: string): RegistryEntry | undefined { return this.entries.get(name); }
  list(): readonly RegistryEntry[] { return [...this.entries.values()]; }
}
export type AgentContext = Omit<TrustedContext, 'owner'> & { readonly owner?: never };
export function sessionOnlyCommand(entry: RegistryEntry | string): boolean {
  const name = typeof entry === 'string' ? entry : entry.name;
  return typeof entry !== 'string' && entry.authority === 'owner-session'
    || ['policy.record', 'grant.record'].includes(name)
    || name.startsWith('confirmation.') || name.startsWith('autonomy.') && name !== 'autonomy.check';
}
export function isOwnerCommand(entry: RegistryEntry | string): boolean {
  return sessionOnlyCommand(entry) || ownerCommands.has(typeof entry === 'string' ? entry : entry.name)
    || typeof entry !== 'string' && entry.authority === 'owner';
}
const safeMessages: Record<ErrorCode, string> = {
  UNCERTAIN: 'The write may have completed but mandatory recording failed; inspect local state before retrying.',
  INVALID_INPUT: 'Invalid input or required trusted authorization is unavailable.',
  NOT_FOUND: 'The command or requested record was not found.', CONFLICT: 'The target revision changed; refresh before retrying.',
  AUTH_EXPIRED: 'Authentication expired. Run coursework browser start and ask the user to sign in.', SOURCE_UNAVAILABLE: 'The required source or adapter is unavailable.',
  LOCKED: 'The target is locked.', CITATION_MISMATCH: 'Citation provenance could not be verified.',
  LIMIT_EXCEEDED: 'The response exceeds 64 KiB.', INTERNAL: 'The command could not complete safely.',
};
function safeError(error: unknown, command?: string): CourseworkError {
  if (command === 'source.fetch' && error instanceof CourseworkError
    && ['Off-origin source URLs are refused.', 'Discussion threads and replies are refused.',
      'Authentication URLs and credentials are refused.', 'Redirects and unsuccessful source responses are refused.',
      'Source download exceeds 10 MiB.'].includes(error.message)) return new CourseworkError(error.code, error.message);
  if (command === 'browser.start') {
    const choice = safeBrowserChoiceMessage(error);
    if (choice) return new CourseworkError('INVALID_INPUT', choice);
    if (error instanceof CourseworkError && error.code === 'LOCKED'
      && /^Browser profile is locked by process [1-9]\d*\.$/.test(error.message)) return new CourseworkError('LOCKED', error.message);
  }
  const code = error instanceof CourseworkError && Object.hasOwn(retryable, error.code) ? error.code : 'INTERNAL';
  return new CourseworkError(code, error instanceof CourseworkError && error.message === 'Open coursework ui to perform this owner action.' ? error.message : safeMessages[code]);
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
  const runId = randomUUID(); const started = performance.now(); let executed = false; let handlerSucceeded = false; let completionRecording = false;
  // Do not let oversized/invalid names inject request prose into the metadata journals.
  const safeName = registry.get(name)?.name ?? 'unknown';
  let refs: Pick<AuditEvent, 'courseId' | 'assessmentId' | 'revision' | 'policyRef' | 'grantRef'> = {};
  const record = async (phase: AuditEvent['phase'], code: AuditEvent['code']) => {
    const event = { ...refs, command: safeName, runId, phase, code };
    const selfAudited = ['autonomy.check', 'audit.record'].includes(name);
    if (!selfAudited || phase === 'denial' && !executed) await context.audit.record(event);
    try { await context.runs.record(event); }
    catch (error) {
      // A shared journal outage must reach the check's own safe audit-denial path.
      // No successful permission is returned if the operational ledger alone fails.
      if (name === 'autonomy.check' && (phase === 'intent' || result?.ok &&
        (result.data as { reason?: string }).reason === 'audit-unavailable')) return;
      throw error;
    }
  };
  let result: Envelope;
  try {
    const entry = registry.get(name);
    if (!entry) throw new CourseworkError('NOT_FOUND', safeMessages.NOT_FOUND);
    const parsed = entry.input.safeParse(input);
    if (!parsed.success) throw new CourseworkError('INVALID_INPUT', safeMessages.INVALID_INPUT);
    if (isOwnerCommand(entry)) {
      if (!context.owner) throw new CourseworkError('INVALID_INPUT', safeMessages.INVALID_INPUT);
      await context.owner.assertOwner(name);
    }
    refs = await context.authorization.references?.(name, entry.level, parsed.data) ?? {};
    await context.authorization.check(name, entry.level, parsed.data);
    if ((entry.level >= 1 || name === 'revision.write' || name === 'practice.write') && name in contracts) await context.evidence.check(name as CommandName, parsed.data);
    await record('intent', 'OK');
    executed = true;
    const raw = await entry.handler(parsed.data, { ...context, runId });
    handlerSucceeded = true;
    const validated = entry.output.safeParse(raw);
    if (!validated.success) throw new CourseworkError('INTERNAL', safeMessages.INTERNAL);
    const protectedOutput = await context.privacy.protect(name, validated.data);
    const finalOutput = entry.output.safeParse(protectedOutput);
    if (!finalOutput.success) throw new CourseworkError('INTERNAL', safeMessages.INTERNAL);
    result = withMetadata(ok(safeName, finalOutput.data), { runId, durationMs: performance.now() - started });
    completionRecording = true;
    await record('outcome', result.ok ? 'OK' : result.error.code);
  } catch (error) {
    // After a contract write/action returned, any later validation, privacy or recording failure is uncertainty.
    let failure = handlerSucceeded && !readNames.has(name) && (completionRecording || writeNames.has(name))
      ? new CourseworkError('UNCERTAIN', safeMessages.UNCERTAIN) : safeError(error, name);
    try { await record(executed ? 'outcome' : 'denial', failure.code); }
    catch { if (failure.code !== 'UNCERTAIN') failure = new CourseworkError('INTERNAL', safeMessages.INTERNAL); }
    result = withMetadata(fail(safeName, failure.code, failure.message, failure.next), { runId, durationMs: performance.now() - started });
  }
  return result;
}
const readNames = new Set<string>(Object.keys(contracts).filter(n => n.endsWith('.list')).concat(['sources.get', 'revision.read', 'practice.stats', 'browser.status']));
/** Contract commands that change state; transports require credentials for these whatever their autonomy level. */
export const writeNames: ReadonlySet<string> = new Set<string>(Object.keys(contracts).filter(n => !readNames.has(n)));
const uncertain = () => new CourseworkError('UNCERTAIN', safeMessages.UNCERTAIN);
/** Bind the settled contract surface to injected ports; no production service is selected here. */
export interface BrowserServices {
  status(): Promise<BrowserStatus>; start(): Promise<BrowserState>; stop(): Promise<void>;
}
export function createRegistry(options: { browser?: Partial<BrowserServices>; autonomy?: AssessmentAutonomy } = {}): Registry {
  const registry = new Registry();
  const handlers = new Map<string, Handler>();
  for (const name of Object.keys(contracts) as CommandName[]) {
    const canonical = name;
    let handler = handlers.get(canonical);
    if (!handler) {
      handler = async (input, context) => {
        if (readNames.has(canonical)) return context.repository.read(canonical as ReadCommand, input as never);
        let target: { courseId?: string; assessmentId?: string } | undefined;
        if (canonical === 'policy.record' || canonical === 'grant.record') {
          // Canonical requests carry identities; legacy payloads are translated by the trusted map before writing.
          const canonicalInput = contracts[canonical].input.safeParse(input);
          if (canonicalInput.success) target = canonicalInput.data;
          else {
            if (!context.services.recordingTarget) throw new CourseworkError('INVALID_INPUT', safeMessages.INVALID_INPUT);
            target = await context.services.recordingTarget(canonical, input);
          }
        }
        const raw = await context.services.write(canonical as WriteCommand, input as never, context);
        if (canonical === 'policy.record' || canonical === 'grant.record') {
          // The write returned: a malformed or wrong-target receipt cannot prove nothing changed.
          const parsed = contracts[canonical].output.safeParse(raw);
          if (!parsed.success) throw uncertain();
          const receipt = parsed.data;
          if (target?.courseId === undefined || receipt.courseId !== target.courseId
            || canonical === 'grant.record' && (!('assessmentId' in receipt) || receipt.assessmentId !== target.assessmentId)) throw uncertain();
        }
        return raw;
      };
      handlers.set(canonical, handler);
    }
    const contract = contracts[name];
    const canonicalHandler = handler;
    registry.register<z.ZodType, z.ZodType>({ name, ...contract, handler: canonicalHandler });
  }
  registry.register({ name: 'browser.status', ...browserContracts['browser.status'], handler: async () =>
    options.browser?.status ? options.browser.status() : browserStatus() });
  registry.register({ name: 'browser.start', ...browserContracts['browser.start'], handler: async () => {
    const state = await (options.browser?.start ? options.browser.start() : ownerResidentBrowser().start());
    return { running: true as const, browser: state.browser, startedAt: state.startedAt };
  } });
  registry.register({ name: 'browser.stop', ...browserContracts['browser.stop'], handler: async () => {
    await (options.browser?.stop ? options.browser.stop() : ownerResidentBrowser().stop()); return { running: false as const };
  } });
  for (const name of Object.keys(autonomyContracts) as (keyof typeof autonomyContracts)[]) {
    registry.register<z.ZodType, z.ZodType>({ name, ...autonomyContracts[name], handler: async (input, context) => {
      if (!options.autonomy) throw new CourseworkError('SOURCE_UNAVAILABLE', safeMessages.SOURCE_UNAVAILABLE);
      return name === 'autonomy.check' ? options.autonomy.check(input as never, context.runId) : options.autonomy.record(input as never, context.runId);
    } });
  }
  return registry;
}
