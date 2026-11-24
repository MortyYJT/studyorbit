// Two small rules about data that may be older than what is on screen.

type SyncRun = { running: boolean; courses: { id: string; status: string; file?: string }[] };
/**
 * Whether a newly read sync state means the course data must be read again. `known` is the signature of the state
 * read before, undefined on the first read after the page loaded. The first read is the baseline, because the page
 * has just loaded that data, unless a sync is running: a course may then have finished between the page's own read
 * and this one, so the data is read once more. Afterwards any change of a course's status or file reloads.
 */
export function syncNeedsReload(known: string | undefined, run: SyncRun): { reload: boolean; signature: string } {
  const signature = JSON.stringify(run.courses.map(course => [course.id, course.status, course.file]));
  return { reload: known === undefined ? run.running : signature !== known, signature };
}

/**
 * Keeps a read that started before a save from overwriting what the save returned. `begin()` when a read starts,
 * `saved()` when a save has succeeded, `accepts(token)` when the read answers.
 */
export function replyGuard(): { begin: () => number; saved: () => void; accepts: (token: number) => boolean } {
  let generation = 0;
  return { begin: () => generation, saved: () => { generation += 1; }, accepts: token => token === generation };
}
