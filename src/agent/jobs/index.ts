import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTool } from '../adapter.js';
import { packageRoot } from '../../config/data-dir.js';
import type { JobKind, JobSpec, PipelineJobContext } from '../../sync/agent-job.js';

/**
 * The layered pipeline's short job prompts (layered-sync task 5.2, #200).
 *
 * One Markdown file per job holds its role and task; `rules.md` holds the shared safety rules. The
 * renderer adds only the job facts (id, course key, the exact URLs the spec allows) and the compact
 * classification list. Page text never enters a prompt: the classifier receives stage values only.
 */

/** The Ed fallback's output tool. No spec names it yet; 5.3 wires the matching command. */
export const ED_OUTPUT_TOOL = 'ed.read';

/** The one output tool each job kind ends with. */
export const OUTPUT_TOOL: Readonly<Record<JobKind, string>> = {
  courses: 'canvas.capture',
  tabs: 'canvas.capture',
  groups: 'canvas.capture',
  handbook: 'handbook.capture',
  main: 'course.map',
  quizzes: 'quizzes.read',
  assignment: 'assignment.saved',
  saver: 'materials.saved',
  ed: ED_OUTPUT_TOOL,
  classify: 'items.classify',
};

const JOB_FILE: Readonly<Record<JobKind, string>> = {
  courses: 'capture.md',
  tabs: 'capture.md',
  groups: 'capture.md',
  handbook: 'handbook.md',
  main: 'main.md',
  quizzes: 'quizzes.md',
  assignment: 'assignment.md',
  saver: 'saver.md',
  ed: 'ed.md',
  classify: 'classify.md',
};

function readJobFile(name: string): string {
  return readFileSync(join(packageRoot(), 'src', 'agent', 'jobs', name), 'utf8').trim();
}

/** Only tools the job needs: its output tool, plus `courses.offer` for the course list job. */
export function tools(spec: JobSpec, all: readonly AgentTool[]): AgentTool[] {
  const needed = new Set([OUTPUT_TOOL[spec.kind]]);
  if (spec.kind === 'courses') needed.add('courses.offer');
  return all.filter(tool => needed.has(tool.name));
}

/** Render one job prompt: shared rules, the job's facts and URLs, then its role, task and output. */
export function prompt(spec: JobSpec, ctx?: PipelineJobContext): string {
  const compact = spec.kind === 'classify' ? compactList(ctx) : '';
  const body = readJobFile(JOB_FILE[spec.kind])
    .replace('{{edOutputTool}}', () => ED_OUTPUT_TOOL)
    .replace('{{compactList}}', () => compact);
  const page = pageNote(spec);
  const urls = spec.urls.length ? spec.urls.map(url => `- ${url}`) : ['None. This job opens no page.'];
  return [
    readJobFile('rules.md'),
    '',
    '# This job',
    `Job id: ${spec.jobId}`,
    spec.courseKey === undefined ? 'Course key: none (course list)' : `Course key: ${spec.courseKey}`,
    '',
    '## URLs you may open',
    ...urls,
    ...(page ? ['', page] : []),
    '',
    body,
    '',
  ].join('\n');
}

/** The page a capture job opens, and the one fallback the course list job may report instead. */
function pageNote(spec: JobSpec): string | undefined {
  if (spec.kind === 'courses') {
    return [
      '## Page',
      'Call `canvas.capture` with page `courses` and no course key.',
      '',
      'If the page is a sign-in page, call `courses.offer` with the job id, no courses and `blocked: ["canvas"]`, then stop. If the computer-use tool or Edge is unavailable, call it the same way with `blocked: ["canvas", "ed"]`, then stop.',
    ].join('\n');
  }
  if (spec.kind === 'tabs' || spec.kind === 'groups') {
    return `## Page\n\nCall \`canvas.capture\` with page \`${spec.kind}\` and this job's course key.`;
  }
  return undefined;
}

/**
 * The classifier's compact list: item names and their Canvas group name and weight, quiz flags, and
 * Handbook components with weights. Stage quotes and descriptions are deliberately never included.
 */
function compactList(ctx?: PipelineJobContext): string {
  const groups = groupRows(ctx?.stages.groups);
  const quizzes = quizRows(ctx?.stages.quizzes);
  const components = componentRows(ctx?.stages.skeleton);
  return [
    '## Compact list',
    '',
    'Canvas items:',
    ...(groups.length ? groups : ['- none']),
    '',
    'Quizzes:',
    ...(quizzes.length ? quizzes : ['- none']),
    '',
    'Handbook components:',
    ...(components.length ? components : ['- none']),
  ].join('\n');
}

function groupRows(stage: unknown): string[] {
  return list(stage, 'groups').flatMap(raw => {
    const group = record(raw);
    if (!group) return [];
    const name = text(group.name) ?? 'unnamed group';
    const weight = number(group.weight) ?? number(record(group.weight)?.value);
    const items = list(group.assignments, 'assignments').flatMap(rawItem => {
      const item = record(rawItem);
      const itemName = item ? text(item.name) : undefined;
      return itemName ? [itemName] : [];
    });
    return (items.length ? items : ['(no items)'])
      .map(item => `- ${item} — group ${name}${weight === undefined ? '' : ` (weight ${weight})`}`);
  });
}

function quizRows(stage: unknown): string[] {
  const quizzes = list(stage, 'quizzes');
  return (quizzes.length ? quizzes : list(stage, 'items')).flatMap(raw => {
    const quiz = record(raw);
    const name = quiz ? text(quiz.name) ?? text(quiz.title) : undefined;
    if (!name) return [];
    const flags = quiz ? quizFlags(quiz) : [];
    return [`- ${name} — ${flags.length ? flags.join(', ') : 'no special flag'}`];
  });
}

function componentRows(stage: unknown): string[] {
  return list(stage, 'components').flatMap(raw => {
    const component = record(raw);
    const name = component ? text(component.name) : undefined;
    if (!name) return [];
    const weight = component ? number(component.weight) : undefined;
    return [`- ${name}${weight === undefined ? '' : ` (weight ${weight})`}`];
  });
}

function quizFlags(quiz: Record<string, unknown>): string[] {
  const flags: string[] = [];
  const kind = typeof quiz.kind === 'string' ? quiz.kind.toLowerCase() : '';
  if (quiz.survey === true || quiz.isSurvey === true || /\bsurvey\b/.test(kind)) flags.push('survey');
  if (quiz.practice === true || quiz.isPractice === true || /\bpractice\b/.test(kind)) flags.push('practice');
  if (Array.isArray(quiz.flags)) for (const flag of quiz.flags) {
    if (typeof flag !== 'string') continue;
    const normal = flag.trim().toLowerCase();
    if ((normal === 'survey' || normal === 'practice') && !flags.includes(normal)) flags.push(normal);
  }
  const objectFlags = record(quiz.flags);
  if (objectFlags?.survey === true && !flags.includes('survey')) flags.push('survey');
  if (objectFlags?.practice === true && !flags.includes('practice')) flags.push('practice');
  return flags;
}

function list(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  const nested = record(value)?.[key];
  return Array.isArray(nested) ? nested : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Names come from stage data, never page text; strip any URL and whitespace so no link leaks in. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/https?:\/\/\S+/gi, '[link]').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 200) : undefined;
}
