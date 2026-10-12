import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from '../citations/exact.js';
import { contracts, FilledTargetSchema, type CommandOutput, type Confirmation, type FilledTarget, type Level, type ParsedCommandInput } from './contracts.js';
import type { ActionAdapter, AuditEvent, ConfirmationService, OwnerInteraction, TrustedContext } from './context.js';
import { CourseworkError } from './errors.js';
import { withReviewedRevision } from '../quiz/review.js';
import { QuizFiles } from '../quiz/files.js';
import type { IdentityMap } from './authorization.js';

type ActionTarget = ParsedCommandInput<'quiz.fill'>;
type Refs = Pick<AuditEvent, 'courseId' | 'assessmentId' | 'revision' | 'policyRef' | 'grantRef'>;
const actionTargetSchema = contracts['quiz.fill'].input;
const submitInputSchema = contracts['quiz.submit'].input;
type FillOutcome = CommandOutput<'quiz.fill'>;
type SubmitOutcome = CommandOutput<'quiz.submit'>;

/** Low-level browser/page drivers. Fill drivers have no submit capability.
 * A driver may throw a CourseworkError coded LOCKED, AUTH_EXPIRED, SOURCE_UNAVAILABLE, INVALID_INPUT or CONFLICT
 * only when it guarantees nothing on the page changed (e.g. unsupported controls). Anything else is uncertain.
 */
export interface FillDriver { fill(target: ActionTarget): Promise<FillOutcome> }
/** No real Ed submit driver exists in M2; M4 supplies a separately reviewed adapter. */
export interface SubmitDriver { submit(target: FilledTarget): Promise<SubmitOutcome> }
const premutation = new Set(['LOCKED', 'AUTH_EXPIRED', 'SOURCE_UNAVAILABLE', 'INVALID_INPUT', 'CONFLICT']);

/** Current trusted review identity for the exact proposal revision and page/attempt. */
export interface ReviewedTarget { assessmentId: string; revision: string; sourceRevision: string; policyRef: string; grantRef: string; page: ActionTarget['page'] }
export interface ReviewPreflight {
  /** Holds the review authority's lock while `fn` runs, so the reviewed state cannot change underneath. */
  withReviewed<T>(request: { assessmentId: string; revision: string; page: ActionTarget['page'] }, fn: (reviewed: ReviewedTarget) => Promise<T>): Promise<T>;
}
/** Q1 exact-review adapter: canonical assessment IDs translate only through the explicit identity map. */
export class Q1ReviewPreflight implements ReviewPreflight {
  constructor(private readonly files: QuizFiles, private readonly identities: IdentityMap) {}
  withReviewed<T>(request: { assessmentId: string; revision: string; page: ActionTarget['page'] }, fn: (reviewed: ReviewedTarget) => Promise<T>): Promise<T> {
    const mapping = this.identities.assessment(request.assessmentId);
    return withReviewedRevision({ assessmentId: mapping.binding.assessmentId, revision: request.revision, page: request.page }, loaded => fn({
      assessmentId: request.assessmentId, revision: loaded.record.revision, sourceRevision: loaded.record.sourceRevision,
      policyRef: loaded.record.policyRef, grantRef: loaded.record.grantRef, page: { ...loaded.page, course: loaded.page.course!, lesson: loaded.page.lesson! },
    }), this.files);
  }
}

/** Current filled revision per assessment. Synthetic in-memory store; durable layout needs owner approval. */
export interface FilledStore {
  get(assessmentId: string): Promise<FilledTarget | undefined>;
  put(target: FilledTarget): Promise<void>;
  clear(assessmentId: string): Promise<void>;
}
export class InMemoryFilledStore implements FilledStore {
  private readonly values = new Map<string, FilledTarget>();
  async get(id: string) { const value = this.values.get(id); return value && structuredClone(value); }
  async put(target: FilledTarget) { this.values.set(target.assessmentId, structuredClone(FilledTargetSchema.parse(target))); }
  async clear(id: string) { this.values.delete(id); }
}

const stale = () => new CourseworkError('CONFLICT', 'Confirmation is missing, stale, expired or already used; confirm the current filled revision again.');
/** O6: server-issued, single-use, short-lived confirmation bound to the exact filled target.
 * Presenting a token always consumes it; issuing a new token revokes older ones for that assessment.
 */
export class SingleUseConfirmations implements ConfirmationService {
  private readonly tokens = new Map<string, { target: string; assessmentId: string; expiresAt: number }>();
  private readonly now: () => number; private readonly ttlMs: number;
  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now; this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1000 || this.ttlMs > 30 * 60 * 1000) throw new CourseworkError('INVALID_INPUT', 'Invalid confirmation lifetime.');
  }
  async issue(target: FilledTarget, owner: OwnerInteraction): Promise<Confirmation> {
    if (!owner) throw new CourseworkError('INVALID_INPUT', 'Owner confirmation is required.');
    await owner.assertOwner('quiz.submit');
    const parsed = FilledTargetSchema.parse(target);
    for (const [token, entry] of this.tokens) if (entry.assessmentId === parsed.assessmentId || entry.expiresAt <= this.now()) this.tokens.delete(token);
    const token = randomBytes(32).toString('base64url'); const expiresAt = this.now() + this.ttlMs;
    this.tokens.set(token, { target: hash(parsed), assessmentId: parsed.assessmentId, expiresAt });
    return { token, target: structuredClone(parsed), expiresAt: new Date(expiresAt).toISOString() };
  }
  async consume(token: string, current: FilledTarget): Promise<void> {
    const entry = this.tokens.get(token); this.tokens.delete(token);
    const parsed = FilledTargetSchema.safeParse(current);
    if (!entry || !parsed.success || this.now() >= entry.expiresAt || entry.target !== hash(parsed.data)) throw stale();
  }
}

/** Narrow authorization port satisfied by SharedAuthorization. */
export interface ActionAuthorization {
  check(command: string, level: Level, input: unknown): Promise<void>;
  references(command: string, level: Level, input: unknown): Promise<Refs>;
  autoSubmit(courseId: string): Promise<boolean>;
}
export interface GatedActionOptions {
  authorization: ActionAuthorization; review: ReviewPreflight; filled: FilledStore; confirmations: ConfirmationService;
  fill?: FillDriver; submit?: SubmitDriver;
}
const uncertain = () => new CourseworkError('UNCERTAIN', 'The action may have completed but its state could not be recorded; inspect the page before any new attempt.');
const conflict = () => new CourseworkError('CONFLICT', 'The reviewed, filled or authorized target changed; review again before acting.');

/** H action boundary: separate L3 fill and L4 submit, serialized per assessment, audited, never retried. */
export class GatedQuizActions implements ActionAdapter {
  private readonly active = new Set<string>();
  constructor(private readonly options: GatedActionOptions) {}

  private async locked<T>(assessmentId: string, fn: () => Promise<T>): Promise<T> {
    if (this.active.has(assessmentId)) throw new CourseworkError('LOCKED', 'Another action for this assessment is active.');
    this.active.add(assessmentId);
    try { return await fn(); } finally { this.active.delete(assessmentId); }
  }
  /** Recheck current policy/grant and the exact reviewed identity inside the review lock. */
  private async preflight<T>(command: 'quiz.fill' | 'quiz.submit', level: Level, target: ActionTarget, fn: (refs: Refs) => Promise<T>): Promise<T> {
    return this.options.review.withReviewed({ assessmentId: target.assessmentId, revision: target.revision, page: target.page }, async reviewed => {
      await this.options.authorization.check(command, level, target);
      const refs = await this.options.authorization.references(command, level, target);
      if (!refs.courseId || refs.assessmentId !== target.assessmentId || refs.policyRef !== target.policyRef || refs.grantRef !== target.grantRef
        || reviewed.assessmentId !== target.assessmentId || reviewed.revision !== target.revision || reviewed.sourceRevision !== target.sourceRevision
        || reviewed.policyRef !== target.policyRef || reviewed.grantRef !== target.grantRef || hash(reviewed.page) !== hash(target.page)) throw conflict();
      return fn({ ...refs, revision: target.revision });
    });
  }
  private async audited<T extends { status: string }>(command: 'quiz.fill' | 'quiz.submit', refs: Refs, context: TrustedContext,
    act: () => Promise<T>, settle: (outcome: T) => Promise<void>): Promise<T> {
    const event = { ...refs, command, runId: randomUUID() };
    // Intent failure blocks the external action entirely.
    await context.audit.record({ ...event, phase: 'intent', code: 'OK' });
    let outcome: T;
    try { outcome = await act(); }
    catch (error) {
      const code = error instanceof CourseworkError && premutation.has(error.code) ? error.code : 'UNCERTAIN';
      await context.audit.record({ ...event, phase: 'outcome', code }).catch(() => {});
      throw code === 'UNCERTAIN' ? uncertain() : new CourseworkError(code, 'The page refused the action before any change.');
    }
    const code = outcome.status === 'partial' || outcome.status === 'uncertain' ? 'UNCERTAIN'
      : outcome.status === 'unavailable' ? 'SOURCE_UNAVAILABLE' : 'OK';
    // Never retried: a recording failure after the external call is reported as uncertainty.
    try { if (code === 'OK') await settle(outcome); await context.audit.record({ ...event, phase: 'outcome', code }); }
    catch { throw uncertain(); }
    return outcome;
  }

  async fill(input: ActionTarget, context: TrustedContext): Promise<FillOutcome> {
    const target = actionTargetSchema.parse(input);
    if (!this.options.fill) return { status: 'unavailable', reason: 'SOURCE_UNAVAILABLE' };
    const driver = this.options.fill;
    return this.locked(target.assessmentId, () => this.preflight('quiz.fill', 3, target, refs => {
      const unknown: FillOutcome = { status: 'uncertain', target, retrySafe: false };
      return this.audited('quiz.fill', refs, context, async () => {
        try {
          const outcome = contracts['quiz.fill'].output.parse(await driver.fill(structuredClone(target)));
          if (outcome.status === 'filled') {
            const { filledRevision: _revision, ...reported } = outcome.target;
            if (hash(reported) !== hash(target)) return unknown;
          } else if (outcome.status !== 'unavailable' && hash(outcome.target) !== hash(target)) return unknown;
          return outcome;
        } catch (error) {
          if (error instanceof CourseworkError && premutation.has(error.code)) throw error;
          return unknown;
        }
      }, async outcome => { if (outcome.status === 'filled') await this.options.filled.put(outcome.target); });
    }));
  }

  /** Host-only issuance for the currently filled revision; the owner confirms in their own interaction. */
  async requestConfirmation(target: FilledTarget, owner: OwnerInteraction | undefined): Promise<Confirmation> {
    if (!owner) throw new CourseworkError('INVALID_INPUT', 'Owner confirmation is required.');
    const parsed = FilledTargetSchema.parse(target);
    const current = await this.options.filled.get(parsed.assessmentId);
    if (!current || hash(current) !== hash(parsed)) throw conflict();
    return this.options.confirmations.issue(parsed, owner);
  }

  async submit(input: ParsedCommandInput<'quiz.submit'>, context: TrustedContext): Promise<SubmitOutcome> {
    const { confirmationToken, ...rest } = submitInputSchema.parse(input);
    const filledTarget = FilledTargetSchema.parse(rest);
    const { filledRevision: _filled, ...target } = filledTarget;
    return this.locked(target.assessmentId, () => this.preflight('quiz.submit', 4, target, async refs => {
      const current = await this.options.filled.get(target.assessmentId);
      if (!current || hash(current) !== hash(filledTarget)) throw conflict();
      // Auto-submit (explicit, owner-set, default off) removes only this confirmation step.
      if (!await this.options.authorization.autoSubmit(refs.courseId!)) {
        if (confirmationToken === undefined) throw new CourseworkError('INVALID_INPUT', 'Current owner confirmation is required before submission.');
        await this.options.confirmations.consume(confirmationToken, filledTarget);
      }
      if (!this.options.submit) {
        // No verified submit adapter: refuse safely, construct no request and claim no submission.
        await context.audit.record({ ...refs, command: 'quiz.submit', runId: randomUUID(), phase: 'denial', code: 'SOURCE_UNAVAILABLE' });
        return { status: 'unavailable', reason: 'SOURCE_UNAVAILABLE' } as const;
      }
      const driver = this.options.submit;
      const unknown: SubmitOutcome = { status: 'uncertain', target, retrySafe: false };
      return this.audited('quiz.submit', refs, context, async () => {
        try {
          const outcome = contracts['quiz.submit'].output.parse(await driver.submit(structuredClone(filledTarget)));
          if (outcome.status === 'submitted' && hash(outcome.target) !== hash(filledTarget)) return unknown;
          if ((outcome.status === 'partial' || outcome.status === 'uncertain') && hash(outcome.target) !== hash(target)) return unknown;
          return outcome;
        } catch (error) {
          if (error instanceof CourseworkError && premutation.has(error.code)) throw error;
          return unknown;
        }
      }, async outcome => { if (outcome.status === 'submitted') await this.options.filled.clear(target.assessmentId); });
    }));
  }
}
