import { z } from 'zod';
import { PolicyRecordSchema, GrantRecordSchema } from './contracts.js';
import type { AuthorizationStore } from './authorization.js';
import type { Repository } from '../store/repository.js';
import type { AuthorizationTarget } from './authorization-rules.js';
import { denyAuthorization } from './authorization-rules.js';
import { ProtocolFiles } from './files.js';
import { hash } from '../citations/exact.js';
/** Current SQLite identities and canonical protocol files; legacy Q1 records are not activated. */
export class CanonicalAuthorizationStore implements AuthorizationStore {
  constructor(private readonly files: ProtocolFiles, private readonly repository: Pick<Repository, 'loadCourse' | 'loadAssessment'>) {}
  course(id: string): void { if (!this.repository.loadCourse(id)) denyAuthorization(); }
  async target(id: string): Promise<AuthorizationTarget> {
    const assessment = this.repository.loadAssessment(id); if (!assessment) return denyAuthorization();
    this.course(assessment.courseId);
    return { courseId: assessment.courseId, assessmentId: assessment.id,
      category: assessment.kind === 'assignment' ? 'assignment' : assessment.kind === 'participation' ? 'ongoing'
        : assessment.kind === 'exam' ? 'exam' : 'unknown' };
  }
  async resolve(input: unknown) { return this.target(z.object({ assessmentId: z.string() }).parse(input).assessmentId); }
  normalizePolicy(input: unknown) { const record = PolicyRecordSchema.parse(input); this.course(record.courseId); return record; }
  normalizeGrant(input: unknown) { return GrantRecordSchema.parse(input); }
  policyReference(record: z.infer<typeof PolicyRecordSchema>) { return hash(record); }
  grantReference(record: z.infer<typeof GrantRecordSchema>) { return hash(record); }
  async policy(courseId: string) {
    const raw = await this.files.read(`protocol-policy-${hash(courseId)}`); if (raw === undefined) return undefined;
    const record = PolicyRecordSchema.parse(raw); if (record.courseId !== courseId) return denyAuthorization();
    return { record, ref: hash(record) };
  }
  async grant(assessmentId: string) {
    const raw = await this.files.read(`protocol-grant-${hash(assessmentId)}`); if (raw === undefined) return undefined;
    const record = GrantRecordSchema.parse(raw); if (record.assessmentId !== assessmentId) return denyAuthorization();
    return { record, ref: hash(record) };
  }
  async savePolicy(record: z.infer<typeof PolicyRecordSchema>) { await this.files.write(`protocol-policy-${hash(record.courseId)}`, record); return hash(record); }
  async saveGrant(record: z.infer<typeof GrantRecordSchema>) { await this.files.write(`protocol-grant-${hash(record.assessmentId)}`, record); return hash(record); }
  exclusive<T>(fn: () => Promise<T>): Promise<T> { return this.files.exclusive(fn); }
}
