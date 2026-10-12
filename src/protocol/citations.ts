import { z } from 'zod';
import { citationMismatch, validateCitation } from '../citations/exact.js';
import { contracts, SourceEvidenceSchema, HashSchema, IdSchema, type CommandName } from './contracts.js';
import type { EvidenceService } from './context.js';
import { CourseworkError } from './errors.js';
export type StudyCommand = 'breakdown.write' | 'revision.write' | 'practice.write';
const targetSchema = z.strictObject({ courseId: IdSchema, assessmentId: IdSchema.optional() });
export type StudyTarget = z.infer<typeof targetSchema>;
const snapshotSchema = z.strictObject({ target: targetSchema, sourceRevision: HashSchema,
  sources: z.array(SourceEvidenceSchema).max(500) });
export interface StudyEvidenceProvider {
  /** Host-injected adapter must independently resolve assessment/course binding and current revision.
   * Return redacted evidence in that target scope, never copied request evidence.
   */
  resolve(target: StudyTarget): Promise<z.infer<typeof snapshotSchema>>;
}
/** Citation-only service. H still owns authorization, privacy, auditing and publication rechecks. */
export class StudyCitationService implements EvidenceService {
  constructor(private readonly provider: StudyEvidenceProvider) {}
  async check(command: CommandName, input: unknown): Promise<void> {
    if (command !== 'breakdown.write' && command !== 'revision.write' && command !== 'practice.write') {
      throw new CourseworkError('SOURCE_UNAVAILABLE', 'Citation adapter is unavailable for this command.');
    }
    await this.validate(command, input);
  }
  async validate(command: StudyCommand, input: unknown) {
    const parsed = contracts[command].input.safeParse(input);
    if (!parsed.success) return citationMismatch();
    const data = parsed.data;
    const target: StudyTarget = 'task' in data
      ? { courseId: data.task.courseId!, assessmentId: data.assessmentId }
      : { courseId: data.courseId };
    const snapshot = snapshotSchema.safeParse(await this.provider.resolve(target));
    if (!snapshot.success || snapshot.data.target.courseId !== target.courseId
      || target.assessmentId !== undefined && snapshot.data.target.assessmentId !== target.assessmentId
      || snapshot.data.sourceRevision !== data.sourceRevision) return citationMismatch();
    const sources = new Map(snapshot.data.sources.map(source => [source.sourceItemId, source]));
    if (sources.size !== snapshot.data.sources.length || snapshot.data.sources.some(source => source.courseId !== target.courseId)) return citationMismatch();
    const claims = 'task' in data ? data.task.steps.map(step => ({ text: step.title, citations: step.citations }))
      : 'claims' in data ? data.claims : data.questions.flatMap(question => question.explanation);
    const units = claims.map(claim => {
      if (!claim.citations.length) return citationMismatch();
      return { text: claim.text, citations: claim.citations.map(citation => {
        const source = sources.get(citation.sourceItemId);
        if (!source || /^page:/u.test(source.locator) && source.page === undefined) return citationMismatch();
        return validateCitation(citation, { sourceItemId: source.sourceItemId, text: source.text,
          locator: source.locator, sourceHash: source.sourceHash, ...(source.page !== undefined ? { page: source.page } : {}) });
      }) };
    });
    return { units, citations: units.flatMap(unit => unit.citations),
      limitations: ['Exact citation membership establishes provenance, not claim correctness.'] };
  }
}
