import { hash } from '../citations/exact.js';
import type { StudyCommand } from '../protocol/citations.js';
import { contracts, type CommandOutput, type ParsedCommandInput } from '../protocol/contracts.js';
import { CourseworkError } from '../protocol/errors.js';
import type { StudyRecord, StudyRecordStore } from '../protocol/study-writes.js';
import type { AcceptedRead, AcceptedRecordReader } from './accepted-records.js';
import type { SqliteRepository } from './sqlite.js';

/** The SQL statement is the cross-process CAS; the lock avoids duplicate in-process validation. */
export class SqliteStudyRecordStore implements StudyRecordStore, AcceptedRecordReader {
  private readonly locks = new Set<string>();
  constructor(private readonly store: SqliteRepository) {}
  async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.locks.has(key)) throw new CourseworkError('LOCKED', 'Another study write is active.');
    this.locks.add(key);
    try { return await fn(); } finally { this.locks.delete(key); }
  }
  async current(command: StudyCommand, id: string): Promise<StudyRecord | undefined> { return this.store.loadStudyRecord(command, id); }
  async publish(command: StudyCommand, id: string, expected: string | undefined, record: StudyRecord): Promise<void> {
    this.store.publishStudyRecord(command, id, expected, record);
  }
  async read<N extends AcceptedRead>(name: N, input: ParsedCommandInput<N>): Promise<CommandOutput<N>> {
    const { cursor, limit, ...filters } = contracts[name].input.parse(input);
    const records = this.store.listStudyRecords(name === 'revision.list' ? 'revision.write' : 'practice.write')
      .filter(record => 'courseId' in record && record.courseId === filters.courseId
        && (filters.week === undefined || record.week === filters.week)
        && (filters.revision === undefined || record.revision === filters.revision));
    const scope = hash([name, filters, records.map(r => [r.id, r.revision])]);
    let offset = 0;
    if (cursor) {
      const decoded = Buffer.from(cursor, 'base64url').toString();
      const match = /^(\d+):([a-f0-9]{64})$/.exec(decoded);
      if (!match || match[2] !== scope || Buffer.from(decoded).toString('base64url') !== cursor
        || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) >= records.length) {
        throw new CourseworkError('INVALID_INPUT', 'Invalid study continuation.');
      }
      offset = Number(match[1]);
    }
    const items = records.slice(offset, offset + limit);
    const next = offset + items.length;
    return contracts[name].output.parse({ items, evidence: [], coverage: { complete: true, gaps: [] },
      ...(next < records.length ? { nextCursor: Buffer.from(`${next}:${scope}`).toString('base64url') } : {}) }) as CommandOutput<N>;
  }
}
