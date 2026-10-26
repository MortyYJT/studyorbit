import type { DatabaseSync } from 'node:sqlite';
import { up as initial } from './001-initial.js';
import { up as syncEvents } from './002-sync-events.js';

import { up as delivery } from './003-delivery.js';
import { up as courseReading } from './004-course-reading.js';
import { up as memories } from './005-memories.js';
import { up as layeredSync } from './006-layered-sync.js';

const migrations = [initial, syncEvents, delivery, courseReading, memories, layeredSync] as const;
export const latestVersion = migrations.length;

function currentVersion(db: DatabaseSync): number {
  return db.prepare('PRAGMA user_version').get()!.user_version as number;
}

function refuseNewer(version: number): void {
  if (version > latestVersion) {
    throw new Error(`Database version ${version} is newer than supported version ${latestVersion}`);
  }
}

/** Schema and version updates commit together; current/newer databases receive no writes. */
export function migrate(db: DatabaseSync): void {
  const recorded = currentVersion(db);
  refuseNewer(recorded);
  if (recorded === latestVersion) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    // Another opener may have migrated while we waited for the write lock.
    const version = currentVersion(db);
    refuseNewer(version);
    for (let index = version; index < migrations.length; index++) {
      migrations[index](db);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
