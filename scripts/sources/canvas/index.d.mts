import type { CollectorCommand, CourseSource, SourceContext } from '../types.d.mts';

export const canvasSource: CourseSource & { discover(ctx: SourceContext, out: string): CollectorCommand };
