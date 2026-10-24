import { registerBrowserTools } from './browser-tools.js';
import type { BrowserTools } from '../browser/tools/service.js';
import type { ToolScope } from '../browser/tools/ports.js';
import { metricsContracts } from '../metrics/contracts.js';
import type { MetricsService } from '../metrics/service.js';
import { annotationContracts, type AnnotationService } from './annotations.js';
import { planningContracts, planningOwnerCommands, planningSessionCommands } from '../planning/contracts.js';
import type { PlanningService } from '../planning/service.js';
import { syncContracts, type SyncCommands, type CourseReadingCommands, type SyncCommandName } from './sync.js';
import { autonomyContracts, type AssessmentAutonomy } from './autonomy.js';
import { safeBrowserChoiceMessage } from '../capture/browser.js';
import { browserStatus, type BrowserStatus } from '../browser/status.js';
import { bringSignInToFront, type SignInSite, type SignInResult } from '../browser/signin.js';
import { ownerResidentBrowser } from '../browser/runtime.js';
import type { BrowserState } from '../browser/resident.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { contracts, browserContracts, ownerCommands, FailureEnvelopeSchema, type Level, type CommandName } from './contracts.js';
import type { TrustedContext, ReadCommand, WriteCommand, AuditEvent } from './context.js';
import { ok, fail, withMetadata, type Envelope } from './envelope.js';
import { AgentFacingError, CourseworkError, retryable, type ErrorCode } from './errors.js';

export type Handler<I = unknown, O = unknown> = (input: I, context: TrustedContext) => O | Promise<O>;
export interface RegistryEntry<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string; input: I; output: O; handler: Handler<z.output<I>, z.output<O>>; level: Level;
  /** Extensions declare owner gates here; transport adapters share this classification. */
  selfAudited?: boolean;
  authority?: 'agent' | 'owner' | 'owner-session';
  references?: (input: unknown) => Pick<AuditEvent, 'courseId' | 'assessmentId' | 'level' | 'policyRef' | 'grantRef'>;
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
    || planningSessionCommands.has(name) || ['policy.record', 'grant.record', 'annotation.confirm', 'annotation.replace'].includes(name)
    || ['browser.view', 'browser.image'].includes(name) || name.startsWith('confirmation.') || name.startsWith('autonomy.') && name !== 'autonomy.check' && name !== 'autonomy.read';
}
export function isOwnerCommand(entry: RegistryEntry | string): boolean {
  return sessionOnlyCommand(entry) || planningOwnerCommands.has(typeof entry === 'string' ? entry : entry.name) || ownerCommands.has(typeof entry === 'string' ? entry : entry.name)
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
export function safeError(error: unknown, command?: string): CourseworkError {
  // Course reading refusals list contract paths so the agent can re-read and resubmit (#170).
  if (error instanceof AgentFacingError && ['courses.offer', 'course.import'].includes(command ?? '')) return new CourseworkError(error.code, error.message);
  if (command === 'source.fetch' && error instanceof CourseworkError
    && ['Off-origin source URLs are refused.', 'Discussion threads and replies are refused.',
      'Authentication URLs and credentials are refused.', 'Redirects and unsuccessful source responses are refused.',
      'Source download exceeds 10 MiB.'].includes(error.message)) return new CourseworkError(error.code, error.message);
  if (command?.startsWith('browser.') && error instanceof CourseworkError && /^Browser action denied: (?:grant-level|course-prohibited|audit-unavailable|authorization-unavailable|assessment-unavailable)\.$/.test(error.message)) return error;
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
  let refs: Pick<AuditEvent, 'courseId' | 'assessmentId' | 'revision' | 'level' | 'policyRef' | 'grantRef'> = {};
  const record = async (phase: AuditEvent['phase'], code: AuditEvent['code']) => {
    const event = { ...refs, command: safeName, runId, phase, code };
    const selfAudited = name === 'autonomy.check' || registry.get(name)?.selfAudited === true;
    if (!selfAudited || name === 'autonomy.check' && phase === 'denial' && !executed) await context.audit.record(event);
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
    refs = entry.references?.(parsed.data) ?? await context.authorization.references?.(name, entry.level, parsed.data) ?? {};
    await context.authorization.check(name, entry.level, parsed.data);
    if ((entry.level >= 1 || name === 'revision.write' || name === 'practice.write') && name in contracts) await context.evidence.check(name as CommandName, parsed.data);
    await record('intent', 'OK');
    executed = true;
    const raw = await entry.handler(parsed.data, { ...context, runId, setAuditReferences: next => { refs = next; } });
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
    let failure = handlerSucceeded && !readNames.has(name) && (completionRecording || writeNames.has(name) || isOwnerCommand(registry.get(name) ?? name))
      ? new CourseworkError('UNCERTAIN', safeMessages.UNCERTAIN) : safeError(error, name);
    try { await record(executed ? 'outcome' : 'denial', failure.code); }
    catch { if (failure.code !== 'UNCERTAIN') failure = new CourseworkError('INTERNAL', safeMessages.INTERNAL); }
    result = withMetadata(fail(safeName, failure.code, failure.message, failure.next), { runId, durationMs: performance.now() - started });
  }
  return result;
}
const readNames = new Set<string>(Object.keys(contracts).filter(n => n.endsWith('.list')).concat(['sources.get', 'revision.read', 'practice.stats', 'browser.status', 'browser.open', 'browser.read', 'browser.screenshot', 'browser.view', 'confirmation.list', 'sync.status', 'courses.candidates', 'plan.read', 'planning.settings.read', 'annotation.read', 'metrics.read', 'autonomy.read']));
/** Contract commands that change state; transports require credentials for these whatever their autonomy level. */
export const writeNames: ReadonlySet<string> = new Set<string>([...Object.keys(contracts), ...Object.keys(planningContracts), ...Object.keys(annotationContracts), ...Object.keys(syncContracts), 'browser.open', 'browser.click', 'browser.fill', 'browser.select', 'browser.submit'].filter(n => !readNames.has(n)));
const uncertain = () => new CourseworkError('UNCERTAIN', safeMessages.UNCERTAIN);
/** Bind the settled contract surface to injected ports; no production service is selected here. */
export interface BrowserServices {
  status(): Promise<BrowserStatus>; start(): Promise<BrowserState>; stop(): Promise<void>;
  signin(site: SignInSite): Promise<SignInResult>;
}
export function createRegistry(options: { browser?: Partial<BrowserServices>; autonomy?: AssessmentAutonomy; planning?: PlanningService; sync?: SyncCommands; courseReading?: CourseReadingCommands; annotations?: AnnotationService; browserTools?: BrowserTools; browserScope?: () => ToolScope; metrics?: MetricsService } = {}): Registry {
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
  registry.register({ name: 'browser.signin', ...browserContracts['browser.signin'], handler: async ({ site }) =>
    options.browser?.signin ? options.browser.signin(site) : bringSignInToFront(site) });
  registry.register({ name: 'browser.start', ...browserContracts['browser.start'], handler: async () => {
    const state = await (options.browser?.start ? options.browser.start() : ownerResidentBrowser().start());
    return { running: true as const, browser: state.browser, startedAt: state.startedAt };
  } });
  registry.register({ name: 'browser.stop', ...browserContracts['browser.stop'], handler: async () => {
    await (options.browser?.stop ? options.browser.stop() : ownerResidentBrowser().stop()); return { running: false as const };
  } });
  for (const name of Object.keys(autonomyContracts) as (keyof typeof autonomyContracts)[]) {
    // autonomy.read is an L0 read with no authority decision: it skips the audit journal (runs still record it).
    if (name === 'autonomy.read') {
      registry.register<z.ZodType, z.ZodType>({ name, ...autonomyContracts[name], selfAudited: true, handler: input => {
        if (!options.autonomy) throw new CourseworkError('SOURCE_UNAVAILABLE', safeMessages.SOURCE_UNAVAILABLE);
        return options.autonomy.read(input);
      } });
      continue;
    }
    registry.register<z.ZodType, z.ZodType>({ name, ...autonomyContracts[name], ...(name !== 'autonomy.check' ? { authority: 'owner-session' as const, references: (input: unknown) => {
      if (!options.autonomy) throw new CourseworkError('SOURCE_UNAVAILABLE', safeMessages.SOURCE_UNAVAILABLE);
      return options.autonomy.references(name, input);
    } } : {}), handler: async (input, context) => {
      if (!options.autonomy) throw new CourseworkError('SOURCE_UNAVAILABLE', safeMessages.SOURCE_UNAVAILABLE);
      return name === 'autonomy.check' ? options.autonomy.check(input as never, context.runId) : options.autonomy.set(name, input, context);
    } });
  }
  for (const [name, contract] of Object.entries(planningContracts)) {
    registry.register<z.ZodType, z.ZodType>({ name, ...contract,
      ...(planningOwnerCommands.has(name) ? { authority: planningSessionCommands.has(name) ? 'owner-session' as const : 'owner' as const } : {}),
      handler: async (input, context) => {
        if (!options.planning) throw new CourseworkError('SOURCE_UNAVAILABLE', safeMessages.SOURCE_UNAVAILABLE);
        if (name === 'plan.read') return options.planning.read(input, async text => String(await context.privacy.protect(name, text)));
        if (name === 'planning.settings.read') return { settings: options.planning.settings() };
        return options.planning.execute(name, input, context.owner);
      },
    });
  }
  for (const name of Object.keys(syncContracts) as SyncCommandName[]) registry.register<z.ZodType, z.ZodType>({ name, ...syncContracts[name],
    // Course selection is the owner's (frontend session or TTY); agents have no command that changes it.
    ...(name === 'courses.select' ? { authority: 'owner' as const } : {}), handler: async (input, context) => {
    if (name === 'sync.run' || name === 'sync.status') {
      if (name === 'sync.run') {
        if (!context.owner) throw new CourseworkError('INVALID_INPUT', safeMessages.INVALID_INPUT);
        await context.owner.assertOwner(name);
      }
      if (!options.sync) throw new CourseworkError('SOURCE_UNAVAILABLE', safeMessages.SOURCE_UNAVAILABLE);
      return name === 'sync.run' ? options.sync.run(input as { course?: string }) : options.sync.status();
    }
    const reading = options.courseReading;
    if (!reading) throw new CourseworkError('SOURCE_UNAVAILABLE', safeMessages.SOURCE_UNAVAILABLE);
    if (name === 'courses.offer') return reading.offer(input as never);
    if (name === 'courses.candidates') return { items: reading.candidates() };
    if (name === 'courses.select') return reading.select(input as never);
    return reading.import(input as never);
  } });
  registerBrowserTools(registry, options.browserTools, options.browserScope);
  for (const name of Object.keys(annotationContracts) as (keyof typeof annotationContracts)[]) {
    const owner = ['annotation.owner.record', 'annotation.confirm', 'annotation.replace'].includes(name);
    registry.register<z.ZodType, z.ZodType>({ name, ...annotationContracts[name], ...(owner ? { authority: name === 'annotation.owner.record' ? 'owner' as const : 'owner-session' as const } : {}), handler: async (input, context) => {
      if (!options.annotations) throw new CourseworkError('SOURCE_UNAVAILABLE', safeMessages.SOURCE_UNAVAILABLE);
      return options.annotations.execute(name, input, context);
    } });
  }
  registry.register({ name: 'metrics.read', ...metricsContracts['metrics.read'], handler: input => {
    if (!options.metrics) throw new CourseworkError('SOURCE_UNAVAILABLE', safeMessages.SOURCE_UNAVAILABLE);
    return options.metrics.read(input);
  } });
  return registry;
}
