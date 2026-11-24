import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CourseDocumentSchema, toDisplayDocument } from '../shared/course-data.ts';
import { runTool, type ToolContext } from '../shared/course-tools.ts';
import { parsePlanningSnapshot } from '../shared/planning-snapshot.ts';

// The two synthetic courses and the planning data under test/fixtures/qa. They were the data of the former chat
// evaluation (docs/eval-chat-qa.md); they stay as the made-up courses used to look at the app and the assistant
// without real data, so this keeps them valid against today's contract.
const DIR = join(import.meta.dirname, 'fixtures', 'qa');
const load = async (name: string) => JSON.parse(await readFile(join(DIR, name), 'utf8'));

describe('synthetic courses', () => {
  it('are valid course documents, and the planning data is a valid snapshot', async () => {
    for (const name of ['SYNT10001.json', 'SYNT20002.json']) expect(CourseDocumentSchema.safeParse(await load(name)).success, name).toBe(true);
    expect(parsePlanningSnapshot(await load('planning.json'))).toMatchObject({ ok: true });
  });

  it('give the course tools something to compute', async () => {
    const context = await load('context.json');
    const documents = await Promise.all(['SYNT10001.json', 'SYNT20002.json'].map(async name => toDisplayDocument(CourseDocumentSchema.parse(await load(name)))));
    const ctx: ToolContext = { documents, courses: context.courses, scope: documents.map(doc => doc.course.id), today: context.today, planning: await load('planning.json') };
    const list = runTool('list_courses', {}, ctx);
    expect(list.ok).toBe(true);
    expect((list.value as { courses: { code: string; synced: boolean }[] }).courses.map(course => [course.code, course.synced])).toEqual([['SYNT10001', true], ['SYNT20002', true]]);
    const grades = runTool('calculate_grades', { courseId: documents[0]!.course.id }, ctx);
    expect(grades.value).toMatchObject({ gradedWeight: 45, earned: 33.66, average: 74.8 });
    expect(runTool('plan_schedule', {}, ctx).value).toMatchObject({ available: true, tasksSource: 'snapshot' });
  });
});
