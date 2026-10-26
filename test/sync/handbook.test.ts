import { describe, expect, it } from 'vitest';
import { handbookUrl, MAX_HANDBOOK_BYTES, parseHandbook } from '../../src/sync/handbook.js';

const source = 'https://handbook.unimelb.edu.au/2026/subjects/comp20003/assessment';

const copied = (hurdle = 'Students must pass the exam to pass the subject.') => [
  'The University of Melbourne Handbook',
  'COMP20003 Algorithms and Data Structures',
  'Assessment',
  'Description\tTiming\tPercentage',
  'Assignments\tWeeks 3-10\t30%',
  'Mid-semester test\tWeek 6\t20%',
  'Exam\tDuring the examination period\t50%',
  '',
  'Hurdle requirements',
  hurdle,
].join('\n');

describe('Handbook skeleton parsing (layered-sync task 4.1)', () => {
  it('builds the assessment URL from the course term and lower-case code', () => {
    expect(handbookUrl('COMP20003', '2026:S2')).toBe('https://handbook.unimelb.edu.au/2026/subjects/comp20003/assessment');
    expect(handbookUrl('abcd10001', '2027:SUMMER')).toBe('https://handbook.unimelb.edu.au/2027/subjects/abcd10001/assessment');
  });

  it('parses three assessment rows with weights, timing, a hurdle on the exam and one quote per row', () => {
    const parsed = parseHandbook(copied(), { source });
    expect(parsed).toMatchObject({ source, via: 'handbook' });
    expect(parsed.components).toHaveLength(3);
    expect(parsed.components.map(component => [component.name, component.weight, component.timing]))
      .toEqual([['Assignments', 30, 'Weeks 3-10'], ['Mid-semester test', 20, 'Week 6'], ['Exam', 50, 'During the examination period']]);
    expect(parsed.components[2]!.hurdle).toMatch(/pass the exam/i);
    expect(parsed.components[0]).not.toHaveProperty('hurdle');
    expect(parsed.components[0]!.quote).toContain('Assignments');
    expect(parsed.components[0]!.quote).toContain('30%');
    for (const component of parsed.components) expect(component.quote.length).toBeLessThanOrEqual(2000);
  });

  it('reads the columns from the header rather than assuming their order and accepts two or more spaces as a separator', () => {
    const parsed = parseHandbook([
      'Assessment type    Description    Timing    Percentage',
      'Written    Assignments    Weeks 3-10    30%',
      'Written    Exam    During the examination period    50%',
    ].join('\n'), { source });
    expect(parsed.components).toMatchObject([
      { name: 'Assignments', weight: 30, timing: 'Weeks 3-10' },
      { name: 'Exam', weight: 50, timing: 'During the examination period' },
    ]);
  });

  it('keeps a hurdle written in the row itself and caps the quote at 2000 characters', () => {
    const long = `Exam\tDuring the examination period\t50%\tHurdle: pass the exam\t${'x'.repeat(2500)}`;
    const parsed = parseHandbook(['Description\tTiming\tPercentage', long].join('\n'), { source });
    expect(parsed.components[0]).toMatchObject({ name: 'Exam', weight: 50, timing: 'During the examination period' });
    expect(parsed.components[0]!.hurdle).toMatch(/pass the exam/i);
    expect(parsed.components[0]!.quote.length).toBe(2000);
  });

  it('refuses a block page without an assessment table and asks for a fresh copy, never echoing the page marker', () => {
    const marker = 'SYNTHETIC_HANDBOOK_BLOCK_MARKER';
    const block = `${marker}: Access denied. Complete the bot check to continue.`;
    expect(() => parseHandbook(block, { source })).toThrow(/assessment table/i);
    try { parseHandbook(block, { source }); }
    catch (error) {
      expect((error as Error).message).toMatch(/fresh copy|copy/i);
      expect((error as Error).message).not.toContain(marker);
    }
  });

  it('refuses text over 1 MB without echoing it', () => {
    const marker = 'SYNTHETIC_HANDBOOK_OVERSIZE_MARKER';
    const text = `${marker}${'x'.repeat(MAX_HANDBOOK_BYTES)}`;
    expect(() => parseHandbook(text, { source })).toThrow(/1 MB|too large/i);
    try { parseHandbook(text, { source }); }
    catch (error) { expect((error as Error).message).not.toContain(marker); }
  });
});
