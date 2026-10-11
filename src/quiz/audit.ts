import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CourseworkError, retryable } from '../protocol/errors.js';
import { run, type Envelope } from '../protocol/envelope.js';
import { QuizFiles } from './files.js';
export const assessmentRefSchema = z.string().regex(/^ed:[1-9]\d{0,15}:[1-9]\d{0,15}$/);
const auditSchema = z.strictObject({ version: z.literal(1), operation: z.enum(['read', 'policy', 'grant', 'prerequisites', 'proposal']),
  phase: z.enum(['intent', 'outcome', 'denial']), at: z.iso.datetime(), runId: z.uuid(),
  assessmentRef: assessmentRefSchema.optional(), revision: z.uuid().optional(), policyRef: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  grantRef: z.string().regex(/^[a-f0-9]{64}$/).optional(), code: z.enum(['OK', ...Object.keys(retryable) as (keyof typeof retryable)[]]),
});
export type AuditOperation = z.infer<typeof auditSchema>['operation'];
export type AuditRefs = Pick<z.infer<typeof auditSchema>, 'assessmentRef' | 'revision' | 'policyRef' | 'grantRef'>;
export class AuditTrail {
  constructor(private readonly append: (line: string) => Promise<void> = line => new QuizFiles().append('audit', line)) {}
  async record(operation: AuditOperation, phase: z.infer<typeof auditSchema>['phase'], runId: string, code: z.infer<typeof auditSchema>['code'], refs: AuditRefs = {}): Promise<void> {
    try {
      if (operation === 'read' && Object.keys(refs).some(key => key !== 'assessmentRef')) throw new Error('Invalid read metadata');
      await this.append(JSON.stringify(auditSchema.parse({ version: 1, operation, phase, at: new Date().toISOString(), runId, code, ...refs })) + '\n');
    }
    catch { throw new CourseworkError('INTERNAL', 'Quiz auditing is unavailable; inspect local state before retrying.'); }
  }
}
export function safeQuizError(error: unknown): CourseworkError {
  const code = error instanceof CourseworkError && Object.hasOwn(retryable, error.code) ? error.code : 'INTERNAL';
  return new CourseworkError(code, 'Quiz operation could not complete.', 'Check private records and authorization; inspect local state before retrying.');
}
export async function auditedMutation(operation: Exclude<AuditOperation, 'read'>, audit: AuditTrail,
  fn: (refs: AuditRefs) => Promise<unknown>, refs: AuditRefs = {}): Promise<Envelope> {
  const runId = randomUUID();
  const result = await run(`quiz.${operation === 'proposal' ? 'propose' : operation}`, async () => {
    await audit.record(operation, 'intent', runId, 'OK', refs);
    try { return await fn(refs); } catch (error) { throw safeQuizError(error); }
  });
  result.meta.runId = runId;
  try { await audit.record(operation, !result.ok && result.error.code === 'INVALID_INPUT' ? 'denial' : 'outcome', runId, result.ok ? 'OK' : result.error.code, refs); }
  catch (error) { const failed = await run(result.command, () => { throw safeQuizError(error); }); failed.meta.runId = runId; return failed; }
  return result;
}
