import { z } from 'zod';
import { contracts, type CommandOutput, type ParsedCommandInput } from '../protocol/contracts.js';
import type { ProtocolServices, ServiceInput, TrustedContext, WriteCommand } from '../protocol/context.js';
import type { StudyEvidenceProvider, StudyTarget } from '../protocol/citations.js';
import { CourseworkError } from '../protocol/errors.js';
import { TrustedStoreEvidence } from '../protocol/reads.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { courseEvidence, SourceFetcher, type SourceTransport } from './source-fetch.js';

export class StoreStudyEvidence implements StudyEvidenceProvider {
  constructor(private readonly store: SqliteRepository, private readonly evidence: TrustedStoreEvidence) {}
  async resolve(target: StudyTarget) {
    if (target.assessmentId && this.store.loadAssessment(target.assessmentId)?.courseId !== target.courseId) {
      throw new CourseworkError('CITATION_MISMATCH', 'Assessment and course do not match.');
    }
    return { ...await courseEvidence(this.store, this.evidence, target.courseId), target };
  }
}
export class RevisionService implements ProtocolServices {
  private readonly fetcher: SourceFetcher;
  constructor(private readonly store: SqliteRepository, private readonly evidence: TrustedStoreEvidence,
    options: { directory?: string; transport?: SourceTransport } = {}) {
    this.fetcher = new SourceFetcher({ store, ...options });
  }
  async write<N extends WriteCommand>(name: N, input: ServiceInput<N>, _context: TrustedContext): Promise<CommandOutput<N>> {
    if (name === 'source.fetch') return await this.fetcher.fetch(input) as CommandOutput<N>;
    if (name !== 'practice.attempt.record') throw new CourseworkError('SOURCE_UNAVAILABLE', 'Revision write unavailable.');
    const parsed = contracts['practice.attempt.record'].input.safeParse(input);
    if (!parsed.success) throw new CourseworkError('INVALID_INPUT', 'Attempt accepts identifiers, outcome and time only.');
    const attempt = parsed.data;
    const records = this.store.listStudyRecords('practice.write').filter(record => 'questions' in record && record.questions.some(q => q.id === attempt.questionId));
    if (records.length === 0) throw new CourseworkError('NOT_FOUND', 'Practice question not found.');
    const matches = records.filter(record => record.revision === attempt.revision);
    if (matches.length !== 1) throw new CourseworkError('CONFLICT', 'Practice revision changed or question identity is ambiguous.');
    // No await between current-revision lookup and append: publication cannot interleave locally.
    this.store.appendPracticeAttempt(attempt);
    return { recorded: true } as CommandOutput<N>;
  }
  async read<N extends 'revision.read' | 'practice.stats'>(name: N, input: ParsedCommandInput<N>): Promise<CommandOutput<N>> {
    const { courseId } = contracts[name].input.parse(input);
    if (!this.store.loadCourse(courseId)) throw new CourseworkError('NOT_FOUND', 'Course not found.');
    if (name === 'revision.read') {
      const scopes = this.store.listStudyRecords('revision.write').filter(record => 'type' in record && record.type === 'exam-scope' && record.courseId === courseId);
      if (scopes.length > 1) throw new CourseworkError('CONFLICT', 'Multiple exam scopes recorded for this course.');
      const finals = []; let cursor: string | undefined;
      do {
        const page = this.store.query('assessments', { courseId, limit: 500, cursor });
        finals.push(...page.items.filter(a => {
          const annotations = this.store.readAnnotations('assessment', a.id).filter(item => item.field === 'isFinal');
          const effective = annotations.filter(item => item.origin === 'owner').at(-1)
            ?? annotations.filter(item => item.origin === 'agent').at(-1);
          return effective ? z.boolean().parse(effective.value) : a.isFinal;
        })); cursor = page.nextCursor;
      } while (cursor);
      if (finals.length > 1) throw new CourseworkError('CONFLICT', 'Multiple final assessments; exam time is ambiguous.');
      const final = finals[0]; let due: string | undefined = final?.due;
      if (final) {
        const annotations = this.store.readAnnotations('assessment', final.id).filter(a => a.field === 'due');
        const owner = annotations.filter(a => a.origin === 'owner').at(-1);
        const agent = annotations.filter(a => a.origin === 'agent').at(-1);
        const effective = owner ?? agent;
        if (effective) {
          if (effective.value === null) due = undefined;
          else due = z.iso.datetime({ offset: true }).parse(effective.value);
        }
      }
      const snapshot = await courseEvidence(this.store, this.evidence, courseId);
      return contracts['revision.read'].output.parse({ sourceRevision: snapshot.sourceRevision, examScope: scopes[0] ?? null,
        ...(final ? { finalAssessmentId: final.id } : {}), ...(due ? { examTime: due } : {}) }) as CommandOutput<N>;
    }
    const questions = this.store.listStudyRecords('practice.write').flatMap(record => 'questions' in record && record.courseId === courseId
      ? record.questions.map(q => ({ questionId: q.id, revision: record.revision })) : []);
    if (questions.length > 500) throw new CourseworkError('LIMIT_EXCEEDED', 'Too many practice questions.');
    let attempted = 0; let correct = 0; let incorrect = 0;
    const wrongQuestions: typeof questions = [];
    for (const question of questions) {
      const attempts = this.store.readPracticeAttempts(question.questionId).filter(a => a.revision === question.revision);
      // The timestamp, with append order breaking equal-time ties, defines the latest attempt.
      const latest = attempts.reduce<(typeof attempts)[number] | undefined>((last, next) =>
        !last || Date.parse(next.at) >= Date.parse(last.at) ? next : last, undefined);
      if (latest?.outcome === 'correct') { attempted++; correct++; }
      if (latest?.outcome === 'incorrect') { attempted++; incorrect++; wrongQuestions.push(question); }
    }
    return { questions: questions.length, attempted, correct, incorrect, wrongQuestions } as CommandOutput<N>;
  }
}
