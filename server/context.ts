// Shared inputs of the route modules. Everything that touches the owner's files or environment comes from here, so
// tests can run every route against a temporary project directory, a temporary Desktop and a synthetic environment.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { SourceSetup } from '../scripts/sources/registry.mjs';

export type Env = Record<string, string | undefined>;
export type RouteContext = {
  /** Project root; local data lives in `<projectDir>/.local`. */
  projectDir: string;
  /** Folder holding the institution's course folders (normally `~/Desktop`). */
  desktopDir: string;
  /** Environment for the analysis model settings (`COURSE_ANALYSIS_*` and vendor keys). */
  env: Env;
  /** `process.platform` unless a test sets another: decides the default browser and which browsers may be chosen. */
  platform: string;
  /** The data-source setup of the current settings file (institution, sources, time zone), read on every call. */
  sourceSetup(): Promise<SourceSetup>;
};
/** A route handler; `req.url` is relative to the route's mount path, as with connect's `use(path, handler)`. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** `.local/lms/courses.json`, the course list written by course discovery. */
export const courseFile = (projectDir: string) => join(projectDir, '.local', 'lms', 'courses.json');
