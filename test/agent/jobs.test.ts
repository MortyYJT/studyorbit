import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRun, AgentTool } from '../../src/agent/adapter.js';
import { ED_OUTPUT_TOOL, prompt, tools } from '../../src/agent/jobs/index.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { AgentSync, type JobKind, type JobSpec, type PipelineJobContext, type SyncPipeline } from '../../src/sync/agent-job.js';
import { SyncJobs } from '../../src/sync/jobs.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const jobId = 'job-synthetic-0001';
const courseKey = 'SYNA10001:2026:S2';
const course = {
  key: courseKey, code: 'SYNA10001', term: '2026:S2',
  pages: { canvas: 'https://canvas.lms.unimelb.edu.au/courses/900001' },
  offeredAt: '2026-10-24T00:00:00Z', selected: true,
};
const stages = {
  groups: {
    source: 'https://canvas.test/api/v1/courses/900001/assignment_groups', via: 'api', coverage: 'api', unweighted: false,
    groups: [{
      id: '1', name: 'Synthetic group', weight: { value: 60, state: 'found', via: 'api' },
      assignments: [{ id: '1', name: 'Synthetic item' }],
    }],
  },
  quizzes: { quizzes: [{
    id: '9', name: 'Synthetic practice quiz', description: 'Synthetic quiz description page text',
    availability: 'Synthetic availability page text', survey: true, practice: true,
  }] },
  skeleton: {
    source: 'https://handbook.test/2026/subjects/syna10001/assessment', via: 'handbook',
    components: [{ name: 'Synthetic component', weight: 30, quote: 'Synthetic handbook row text' }],
    hurdles: 'Synthetic hurdle page text',
  },
};
const context: PipelineJobContext = { jobId, courseKey, course, stages };

const urls: Record<JobKind, string[]> = {
  courses: ['https://canvas.test/api/v1/courses'],
  tabs: ['https://canvas.test/api/v1/courses/900001/tabs'],
  groups: ['https://canvas.test/api/v1/courses/900001/assignment_groups'],
  handbook: ['https://handbook.test/2026/subjects/syna10001/assessment'],
  main: ['https://canvas.test/courses/900001'],
  quizzes: ['https://canvas.test/courses/900001/quizzes'],
  assignment: ['https://canvas.test/courses/900001/assignments/1'],
  saver: ['https://canvas.test/courses/900001/modules', 'https://canvas.test/files/folder/1'],
  ed: ['https://edstem.test/au/courses/800001'],
  classify: [],
};
const outputTools: Record<JobKind, string> = {
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
const specFor = (kind: JobKind): JobSpec => ({ kind, jobId, ...(kind === 'courses' ? {} : { courseKey }), urls: urls[kind] });

/** The URLs in a rendered prompt, without trailing Markdown punctuation. */
const urlsIn = (text: string): string[] => [...text.matchAll(/https?:\/\/[^\s<>()[\]`"']+/g)]
  .map(match => match[0].replace(/[.,;:]+$/, ''));

const allTools: readonly AgentTool[] = ['canvas.capture', 'courses.offer', 'handbook.capture', 'course.map',
  'quizzes.read', 'assignment.saved', 'materials.saved', 'ed.read', 'items.classify', 'course.import', 'source.record']
  .map(name => ({ name, description: name, inputSchema: {}, execute: async () => undefined }));
const toolNames = (kind: JobKind): string[] => tools(specFor(kind), allTools).map(tool => tool.name).sort();

describe('pipeline job prompts (layered-sync task 5.2)', () => {
  it.each(Object.keys(outputTools) as JobKind[])('%s: names the output tool, job id and course key, and lists exactly its URLs', kind => {
    const spec = specFor(kind);
    const text = prompt(spec, context);
    expect(text).toContain(outputTools[kind]);
    expect(text).toContain(spec.jobId);
    if (kind === 'courses') expect(text).not.toContain(courseKey);
    else expect(text).toContain(courseKey);
    expect(text).toContain('open no other page');
    expect(text.toLowerCase()).toContain('sign-in page');
    expect(text.toLowerCase()).toContain('never type a password');
    expect(text.toLowerCase()).toContain("open its own edge window");
    expect(text.toLowerCase()).toContain('never submit, post or press a button');
    expect(text.toLowerCase()).toContain('only tool calls count');
    expect(text.toLowerCase()).toContain('end after the one output tool call');
    expect(new Set(urlsIn(text))).toEqual(new Set(spec.urls));
  });

  it('courses: names courses.offer for a sign-in page or an unavailable computer-use tool or Edge', () => {
    const text = prompt(specFor('courses'), context);
    expect(text).toContain('courses.offer');
  });

  it('assignment: names the Canvas assignment id the output is stored under', () => {
    const text = prompt({ ...specFor('assignment'), target: '500123' }, context);
    expect(text).toContain('Assignment id: 500123');
    expect(text).toContain('`assignmentId`');
  });

  it('Handbook: lists only the one Handbook assessment URL', () => {
    const spec = specFor('handbook');
    const found = urlsIn(prompt(spec, context));
    expect(found).toHaveLength(1);
    expect(found).toEqual(spec.urls);
  });

  it('saver: opens every URL listed for the job, including a Files folder, not only the modules page', () => {
    const spec = { ...specFor('saver'), urls: ['https://canvas.test/courses/900001/modules',
      'https://canvas.test/courses/900001/files/folder/1'] };
    const text = prompt(spec, context);
    for (const url of spec.urls) expect(text).toContain(url);
    expect(new Set(urlsIn(text))).toEqual(new Set(spec.urls));
    expect(text).toContain('each URL listed');
    expect(text.toLowerCase()).toContain('files folder');
    expect(text).not.toMatch(/open the modules page/i);
  });

  it('rules: allows following file or attachment links on a listed page for the named downloads', () => {
    const text = prompt(specFor('saver'), context);
    expect(text).toContain('Following the file or attachment links on a listed page');
    expect(text).toContain('nothing else');
  });

  it('courses: after canvas.capture refuses a sign-in page, offers the course list and stops', () => {
    const text = prompt(specFor('courses'), context);
    expect(text).toContain('If `canvas.capture` is refused because the copied page is a sign-in page');
    expect(text).toContain('blocked: ["canvas"]');
    expect(text).toContain('then stop');
    expect(text).toContain('for the course list, after `courses.offer` when it is used');
  });

  it('classifier: names each stage item id so repeated names in different groups stay distinct', () => {
    const repeated: PipelineJobContext = { ...context, stages: {
      ...stages,
      groups: { ...stages.groups, groups: [
        { id: '10', name: 'Quizzes', weight: { value: 20 }, assignments: [{ id: '500001', name: 'Quiz 1' }] },
        { id: '11', name: 'Practice', weight: { value: 0 }, assignments: [{ id: '500002', name: 'Quiz 1' }] },
      ] },
      quizzes: { quizzes: [{ id: '700001', name: 'Quiz 1' }] },
    } };
    const text = prompt(specFor('classify'), repeated);
    expect(text).toContain('[id 500001] Quiz 1');
    expect(text).toContain('[id 500002] Quiz 1');
    expect(text).toContain('[id 700001] Quiz 1');
    expect(text.toLowerCase()).toContain('echo');
  });

  it('classifier: lists no URL and carries the compact list without page text', () => {
    const text = prompt(specFor('classify'), context);
    expect(text).not.toMatch(/https?:\/\//);
    for (const field of ['Synthetic item', 'Synthetic group', '60', 'Synthetic practice quiz', 'survey', 'practice',
      'Synthetic component', '30']) expect(text).toContain(field);
    for (const pageText of ['Synthetic quiz description page text', 'Synthetic availability page text',
      'Synthetic handbook row text', 'Synthetic hurdle page text']) expect(text).not.toContain(pageText);
  });

  it('classifier: still renders without stage context', () => {
    const text = prompt(specFor('classify'));
    expect(text).toContain('items.classify');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('tools: returns only the tools the job needs from a synthetic full list', () => {
    expect(toolNames('courses')).toEqual(['canvas.capture', 'courses.offer']);
    expect(toolNames('tabs')).toEqual(['canvas.capture']);
    expect(toolNames('groups')).toEqual(['canvas.capture']);
    expect(toolNames('handbook')).toEqual(['handbook.capture']);
    expect(toolNames('main')).toEqual(['course.map']);
    expect(toolNames('quizzes')).toEqual(['quizzes.read']);
    expect(toolNames('assignment')).toEqual(['assignment.saved']);
    expect(toolNames('saver')).toEqual(['materials.saved']);
    expect(toolNames('ed')).toEqual([ED_OUTPUT_TOOL]);
    expect(toolNames('classify')).toEqual(['items.classify']);
  });

  it('tools: a tool that is not in the full list is simply absent', () => {
    const only = allTools.filter(tool => tool.name === 'source.record');
    expect(tools(specFor('main'), only)).toEqual([]);
  });

  it('orchestrator: passes the course, job id and stages context to prompt', async () => {
    const store = new SqliteRepository(':memory:');
    cleanups.push(() => store.close());
    store.saveCourseSelections([course]);
    const jobs = new SyncJobs(store);
    const seen: (PipelineJobContext | undefined)[] = [];
    const adapter: AgentAdapter = {
      id: 'synthetic',
      start: (): AgentRun => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent, void> { yield { type: 'result', turns: 1 }; },
        interrupt() {},
      }),
    };
    const pipeline: SyncPipeline = {
      prompt: (spec, ctx) => { seen.push(ctx); return `Job id: ${spec.jobId}`; },
      tools: () => [],
      build: () => undefined,
    };
    const sync = new AgentSync({ store, jobs, adapter: () => adapter, tools: () => [], pipeline });
    await sync.run({});
    expect(seen[0]).toBeUndefined();
    const courseContexts = seen.slice(1);
    expect(courseContexts.length).toBeGreaterThan(0);
    for (const ctx of courseContexts) {
      expect(ctx).toMatchObject({ jobId: expect.any(String), courseKey, course: { code: 'SYNA10001' } });
      expect(ctx!.stages).toBeTypeOf('object');
    }
  });
});
