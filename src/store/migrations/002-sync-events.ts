import type { DatabaseSync } from 'node:sqlite';
import { ChangeSchema } from '../../domain/schemas.js';

const operations: Record<string, 'created' | 'updated' | 'deleted'> = {
  'item.added': 'created',
  'item.removed': 'deleted',
  'content.changed': 'updated',
  'deadline.changed': 'updated',
  'grade.changed': 'updated',
};

/** The migration runner owns the transaction; no unsupported history is discarded. */
export function up(db: DatabaseSync): void {
  // Preflight both indexed and JSON platform values before the first schema/data write.
  for (const row of db.prepare('SELECT platform, json FROM source_items').iterate()) {
    let source: unknown;
    try { source = JSON.parse(row.json as string); }
    catch { throw new Error('Cannot upgrade invalid source history. Preserve a private backup and ask the owner to inspect it.'); }
    if (row.platform === 'ical' || (source !== null && typeof source === 'object' && 'platform' in source && source.platform === 'ical')) {
      throw new Error('Legacy iCal data detected. Stop and ask the owner for a retention/removal decision; preserve a private backup. No data was changed.');
    }
  }

  db.exec('ALTER TABLE changes RENAME TO change_event');
  for (const row of db.prepare('SELECT seq, entity, entityId, at, json FROM change_event ORDER BY seq').iterate()) {
    try {
      const event: unknown = JSON.parse(row.json as string);
      if (event === null || typeof event !== 'object' || !('kind' in event) || typeof event.kind !== 'string') throw new Error();
      const kind = Object.hasOwn(operations, event.kind) ? operations[event.kind] : event.kind;
      const migrated = { ...event, kind };
      const validated = ChangeSchema.parse(migrated);
      if (validated.seq !== row.seq || validated.entity !== row.entity || validated.entityId !== row.entityId || validated.at !== row.at) throw new Error();
      db.prepare('UPDATE change_event SET json = ? WHERE seq = ?').run(JSON.stringify(migrated), validated.seq);
    } catch {
      // Never echo validation issues containing source snapshots or unexpected raw values.
      throw new Error('Cannot upgrade invalid change history. Preserve a private backup and ask the owner to inspect it. No data was changed.');
    }
  }
}
