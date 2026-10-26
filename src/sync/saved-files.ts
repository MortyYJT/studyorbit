import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { SavedFile } from '../domain/schemas.js';
import type { SavedFileView } from '../protocol/contracts.js';
import { CourseworkError } from '../protocol/errors.js';
import {
  courseFolderPath, hasUpdateNotice, markOpened,
  type CourseFolderCourse, type CourseFolderOptions, type MarkOpenedStore,
} from './course-folder.js';

/** The store seam for opening and rendering saved files; tests use the real store inside a temp folder. */
export interface SavedFileStore extends MarkOpenedStore {
  loadCourse(id: string): CourseFolderCourse | undefined;
}

/** The host's default application, injectable so tests never launch anything. */
export type FileOpener = (path: string) => Promise<void>;

/** Production opener: macOS `open <path>` through `execFile`, never a shell. */
export const openWithHostDefaultApp: FileOpener = path => new Promise((resolveOpen, reject) => {
  if (process.platform !== 'darwin') {
    reject(new CourseworkError('SOURCE_UNAVAILABLE', 'Opening saved files uses the macOS open command.'));
    return;
  }
  execFile('open', [path], error => {
    if (error) reject(new CourseworkError('SOURCE_UNAVAILABLE', 'The saved file could not be opened.'));
    else resolveOpen();
  });
});

/** The file name only; the stored path (relative or legacy absolute) never leaves the server. */
export function savedFileName(path: string): string {
  return path.split(/[\\/]/).filter(part => part.length > 0).at(-1) ?? path;
}

/** One record as a read item: current files first only to break a saved-at tie. */
export function savedFileView(records: readonly SavedFile[], file: SavedFile): SavedFileView {
  return {
    id: file.id,
    name: savedFileName(file.path),
    current: file.supersededAt === undefined,
    savedAt: file.savedAt,
    ...(file.supersededAt === undefined ? {} : { supersededAt: file.supersededAt }),
    ...(file.openedAt === undefined ? {} : { openedAt: file.openedAt }),
    updated: hasUpdateNotice(records, file),
  };
}

/** Newest first, capped to the per-assessment read bound; `updated` still sees every record. */
export function savedFileViews(records: readonly SavedFile[], limit = 20): SavedFileView[] {
  const currentFirst = (file: SavedFile) => file.supersededAt === undefined ? 0 : 1;
  return [...records]
    .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt)
      || currentFirst(left) - currentFirst(right) || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map(file => savedFileView(records, file));
}

export interface OpenSavedFileOptions {
  folder?: CourseFolderOptions;
  /** Alias for `folder.root`. */
  root?: string;
  opener?: FileOpener;
  now?: () => Date;
}

/**
 * Resolve the stored path inside its course folder, refuse anything that is not a regular file there, open it with
 * the host's default app, then mark it opened. The stored path is never returned to the caller.
 */
export async function openSavedFile(store: SavedFileStore, savedFileId: string,
  options: OpenSavedFileOptions = {}): Promise<{ opened: true; openedAt: string }> {
  const saved = store.loadSavedFile(savedFileId);
  if (!saved) throw new CourseworkError('NOT_FOUND', 'Saved file not found.');
  const path = resolveSavedFilePath(store, saved,
    options.folder ?? (options.root === undefined ? {} : { root: options.root }));
  await (options.opener ?? openWithHostDefaultApp)(path);
  const opened = markOpened(store, saved.id, options.now?.() ?? new Date());
  return { opened: true, openedAt: opened.openedAt! };
}

/** Absolute real path of one saved file, or a fixed refusal when it escapes the course folder or is not a file. */
export function resolveSavedFilePath(store: Pick<SavedFileStore, 'loadCourse'>, saved: SavedFile,
  options: CourseFolderOptions = {}): string {
  const course = store.loadCourse(saved.courseId);
  if (!course) throw new CourseworkError('NOT_FOUND', 'The saved file\'s course is not stored.');
  const root = resolve(courseFolderPath(course, options));
  const candidate = isAbsolute(saved.path) ? resolve(saved.path) : resolve(root, saved.path);
  if (!inside(root, candidate)) throw new CourseworkError('INVALID_INPUT', 'The saved file path is outside the course folder.');
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(candidate);
  } catch {
    throw new CourseworkError('NOT_FOUND', 'The saved file is missing.');
  }
  if (!entry.isFile()) throw new CourseworkError('INVALID_INPUT', 'The saved record is not a regular file.');
  // Resolve links after the lexical check so a linked parent cannot place the file outside the folder.
  let realRoot: string; let realCandidate: string;
  try {
    realRoot = realpathSync(root);
    realCandidate = realpathSync(candidate);
  } catch {
    throw new CourseworkError('NOT_FOUND', 'The saved file is missing.');
  }
  if (!inside(realRoot, realCandidate)) throw new CourseworkError('INVALID_INPUT', 'The saved file path is outside the course folder.');
  // The lexical absolute path stays inside the configured folder; the real-path check above already refused links out.
  return candidate;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
