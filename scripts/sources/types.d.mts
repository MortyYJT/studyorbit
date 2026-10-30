// The course source interface (openspec change generic-adapters, design §1, decision #440).
import type { RefPlatform } from '../lib/course-refs.mjs';
import type { Institution } from '../institutions/types.d.mts';
import type { SourceConfig } from './config.mjs';

/** Also the checkpoint key and the run-directory file name (`<id>.json`). */
export type SourceId = 'canvas' | 'ed' | (string & {});
/** A collector process: `scripts/<script> ...args` with `env` added to the server's environment. */
export type CollectorCommand = { script: string; args: string[]; env: Record<string, string> };
/** What a source builds its commands from. `env` carries STUDYORBIT_SOURCE_CONFIG. */
export type SourceContext = { settings: SourceConfig; institution: Institution; env: Record<string, string> };
/** A course candidate of the course list. */
export type CourseCandidate = { id: string; subjectCode: string; term?: unknown; [key: string]: unknown };

export interface CourseSource {
  id: SourceId;
  /** Shown in reasons and the page: 'Canvas', 'Ed', or the framework source's name. */
  label: string;
  /** Joins the shared browser limiter. */
  usesBrowser: boolean;
  /** Per-platform limiter key of the pipeline (sources that use the browser share 'browser'). */
  limiter: string;
  /** Reference platforms it provides. */
  platforms: readonly RefPlatform[];
  discover?(ctx: SourceContext, out: string): CollectorCommand;
  /** Null when the source does not apply to the course. */
  collect(course: CourseCandidate, ctx: SourceContext, out: string): CollectorCommand | null;
  /**
   * A cheap check run once per job before any collection (sync-incomplete fix 2): exit 0 when the source can be
   * collected. A `blocking` failure stops the job before any collector or model call; otherwise it is a warning.
   */
  preflight?: { blocking: boolean; command(ctx: SourceContext): CollectorCommand };
  /** The `unavailable` object written when the collector fails, unchanged from before the move. */
  placeholder(reason?: string): object;
}
