import { createHash, randomUUID } from 'node:crypto';
import { AuditRecordSchema, type AuditRecord } from './contracts.js';
import type { AuditEvent } from './context.js';
import { CourseworkError } from './errors.js';
import { ProtocolFiles } from './files.js';
import { auditSchema } from './legacy-audit.js';
import { RunSchema } from '../domain/schemas.js';
const safeReference = /^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,255}$/;
function safe(record: AuditRecord): AuditRecord {
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/.test(record.command)
    || record.courseId !== undefined && !safeReference.test(record.courseId)
    || record.assessmentId !== undefined && !safeReference.test(record.assessmentId)) throw new Error('Invalid audit reference');
  return record;
}
const unavailable = () => new CourseworkError('INTERNAL', 'Durable metadata recording is unavailable.');
/** Uses the existing private append-only journal. Q1 lines are read, never rewritten. */
export class DurableAudit {
  constructor(private readonly files = new ProtocolFiles()) {}
  async record(event: AuditEvent): Promise<void> {
    try {
      const record = safe(AuditRecordSchema.parse({ ...event, id: randomUUID(), at: new Date().toISOString() }));
      await this.files.append('audit', JSON.stringify(record) + '\n');
    } catch { throw unavailable(); }
  }
  async list(): Promise<AuditRecord[]> {
    try {
      return (await this.files.readLog('audit')).map(raw => {
        const current = AuditRecordSchema.safeParse(raw); if (current.success) return safe(current.data);
        const legacy = auditSchema.parse(raw);
        // Stable synthetic record identity; no guessed M1 identity from the provider reference.
        const digest = createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
        const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        const { assessmentRef, revision, policyRef, grantRef } = legacy;
        return safe(AuditRecordSchema.parse({ id, command: `quiz.${legacy.operation === 'proposal' ? 'propose' : legacy.operation}`,
          runId: legacy.runId, phase: legacy.phase, at: legacy.at, code: legacy.code,
          ...(assessmentRef ? { assessmentId: assessmentRef } : {}), ...(revision ? { revision } : {}),
          ...(policyRef ? { policyRef } : {}), ...(grantRef ? { grantRef } : {}) }));
      });
    } catch { throw unavailable(); }
  }
}
/** Separate ledger. Only timings observed here are recorded; no fabricated source measurements. Steps count internal workflow steps (none in this sink). */
export class DurableRuns {
  private readonly starts = new Map<string, string>();
  constructor(private readonly files = new ProtocolFiles()) {}
  async record(event: AuditEvent): Promise<void> {
    try {
      const parsed = safe(AuditRecordSchema.parse({ ...event, id: randomUUID(), at: new Date().toISOString() }));
      if (parsed.phase === 'intent') { await this.files.append('runs', ''); this.starts.set(parsed.runId, parsed.at); return; }
      const startedAt = this.starts.get(parsed.runId) ?? parsed.at;
      const record = RunSchema.parse({ id: parsed.runId, command: parsed.command, startedAt, endedAt: parsed.at,
        steps: 0, outcome: parsed.code === 'OK' ? 'ok' : 'error', ...(parsed.code === 'OK' ? {} : { errorCode: parsed.code }) });
      await this.files.append('runs', JSON.stringify(record) + '\n'); this.starts.delete(parsed.runId);
    } catch { throw unavailable(); }
  }
}
