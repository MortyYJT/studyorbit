import type { FrameworkComponent as HandbookComponent, FrameworkRow as HandbookRow } from '../../lib/course-refs.mjs';

export function parseHandbookRows(text: unknown): HandbookRow[];
export function parseHandbookComponents(text: unknown): HandbookComponent[];
