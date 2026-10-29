import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadQaFixtures, toolContextFor } from '../scripts/eval-chat-qa.mjs';
import { valueAt } from '../scripts/lib/qa-grade.mjs';
import { courseTools, runTool } from '../shared/course-tools.ts';

// The synthetic Q&A set (spec chat-qa-eval): every gold number must be what the registry returns on the fixtures.
const DIR = join(import.meta.dirname, 'fixtures', 'qa');
const fixtures = await loadQaFixtures(DIR);
const CATEGORIES = ['lookup', 'weight', 'grade', 'final', 'schedule', 'refusal', 'out-of-scope', 'missing'];

describe('Q&A fixtures', () => {
  it('has at least 24 uniquely named questions in Chinese and English across every category', () => {
    const { questions } = fixtures;
    expect(questions.length).toBeGreaterThanOrEqual(24);
    expect(new Set(questions.map(question => question.id)).size).toBe(questions.length);
    expect(new Set(questions.map(question => question.category))).toEqual(new Set(CATEGORIES));
    expect(new Set(questions.map(question => question.language))).toEqual(new Set(['zh', 'en']));
  });

  it('gives every question a known scope and complete gold data', () => {
    const known = new Set(fixtures.courses.map(course => course.id));
    const tools = new Set(courseTools.map(tool => tool.name));
    for (const question of fixtures.questions) {
      expect(question.scope.length, question.id).toBeGreaterThan(0);
      for (const id of question.scope) expect(known.has(id), `${question.id} scope ${id}`).toBe(true);
      const { gold } = question;
      expect(typeof gold.answer, question.id).toBe('string');
      expect(gold.numbers.length + gold.facts.length + gold.forbidden.length + (gold.refusal ? 1 : 0), `${question.id} has no check`).toBeGreaterThan(0);
      for (const group of gold.facts) expect(group.length, question.id).toBeGreaterThan(0);
      for (const name of gold.expectTools) expect(tools.has(name), `${question.id} expects ${name}`).toBe(true);
    }
  });

  it('matches every gold number to its source call on the fixtures', () => {
    let checked = 0;
    for (const question of fixtures.questions) {
      for (const entry of question.gold.numbers) {
        const result = runTool(entry.source.tool, entry.source.args, toolContextFor(fixtures, question));
        expect(result.ok, `${question.id}: ${result.text}`).toBe(true);
        expect(valueAt(result.value, entry.source.path), `${question.id} ${entry.source.path}`).toBe(entry.value);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it('holds synthetic data only', async () => {
    for (const doc of fixtures.documents) expect(doc.course.code).toMatch(/^SYNT\d{5}$/);
    for (const name of await readdir(DIR)) {
      const text = await readFile(join(DIR, name), 'utf8');
      expect(text, name).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\|@[a-z0-9-]+\.[a-z]{2,}|sk-[A-Za-z0-9]/);
    }
  });
});
