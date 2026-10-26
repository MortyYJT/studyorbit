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

describe('Handbook parser review findings (#190)', () => {
  const table = (...rows: string[]) => ['Description\tTiming\tPercentage', ...rows].join('\n');

  it('takes the weight only from the Percentage column when the name contains a percentage', () => {
    const parsed = parseHandbook(table(
      'Attendance at 80% of tutorials\tThroughout semester\tN/A',
      'Attendance at 85% of tutorials\tThroughout semester\tHurdle',
      'Attendance at 90% of tutorials\tThroughout semester\t',
    ), { source });
    expect(parsed.components.map(component => component.weight)).toEqual([undefined, undefined, undefined]);
    expect(parsed.components[0]).not.toHaveProperty('hurdle');
    expect(parsed.components[1]).toMatchObject({ hurdle: 'Hurdle' });
    expect(parsed.components[2]).not.toHaveProperty('hurdle');
    for (const component of parsed.components) expect(component.quote).toContain('%');
  });

  it('keeps an empty Percentage cell aligned even when a later cell contains a percentage', () => {
    const parsed = parseHandbook([
      'Description\tTiming\tPercentage\tNotes',
      'Attendance at 80% of tutorials\tThroughout semester\t\t40%',
    ].join('\n'), { source });
    expect(parsed.components[0]).not.toHaveProperty('weight');
  });

  it('keeps later rows across a single blank line', () => {
    const parsed = parseHandbook(table(
      'Assignments\tWeeks 3-10\t30%',
      '',
      'Exam\tDuring the examination period\t50%',
    ), { source });
    expect(parsed.components.map(component => [component.name, component.weight]))
      .toEqual([['Assignments', 30], ['Exam', 50]]);
  });

  it('treats a wrapped description line as a continuation and keeps later rows', () => {
    const parsed = parseHandbook(table(
      'Assignments\tWeeks 3-10\t30%',
      'The assignments include a report and a presentation.',
      'Exam\tDuring the examination period\t50%',
    ), { source });
    expect(parsed.components.map(component => [component.name, component.weight]))
      .toEqual([['Assignments', 30], ['Exam', 50]]);
    expect(parsed.components[0]!.quote).toContain('report and a presentation');
  });

  it('ends the table only after two consecutive blank lines', () => {
    const parsed = parseHandbook(table(
      'Assignments\tWeeks 3-10\t30%',
      '',
      '',
      'Exam\tDuring the examination period\t50%',
    ), { source });
    expect(parsed.components.map(component => component.name)).toEqual(['Assignments']);
  });

  it('never turns a footer or navigation row into a component', () => {
    const parsed = parseHandbook(table(
      'Assignments\tWeeks 3-10\t30%',
      'Exam\tDuring the examination period\t50%',
      'Print    Share    Feedback',
    ), { source });
    expect(parsed.components.map(component => component.name)).toEqual(['Assignments', 'Exam']);
  });

  it('does not open the hurdle section from prose that merely contains the word', () => {
    const parsed = parseHandbook(table(
      'Exam\tDuring the examination period\t50%',
      '',
      'This subject has a hurdle requirement: students must pass the Exam.',
    ), { source });
    expect(parsed.components[0]).not.toHaveProperty('hurdle');
    expect(parsed).not.toHaveProperty('hurdles');
  });

  it('matches a component name in the hurdle section on whole words', () => {
    const parsed = parseHandbook(table(
      'Test\tWeek 6\t20%',
      'Exam\tDuring the examination period\t50%',
      '',
      'Hurdle requirements',
      'Students must pass the latest exam.',
    ), { source });
    expect(parsed.components[0]).not.toHaveProperty('hurdle');
    expect(parsed.components[1]!.hurdle).toMatch(/latest exam/);
  });

  it('returns the hurdle section even when it names no component', () => {
    const parsed = parseHandbook(table(
      'Exam\tDuring the examination period\t50%',
      '',
      'Hurdle requirements:',
      'Students must attend 75% of tutorials.',
    ), { source });
    expect(parsed.hurdles).toMatch(/75% of tutorials/i);
    expect(parsed.components[0]).not.toHaveProperty('hurdle');
  });

  it('keeps a wrapped "Hurdle requirement:" line inside a row as that row\'s hurdle and keeps later rows', () => {
    const parsed = parseHandbook(table(
      'Exam\tEnd of semester\t50%',
      'Hurdle requirement: students must pass the exam',
      'Assignments\tWeeks 3-10\t30%',
      'Quiz\tWeek 4\t20%',
    ), { source });
    expect(parsed.components.map(component => [component.name, component.weight])).toEqual([['Exam', 50], ['Assignments', 30], ['Quiz', 20]]);
    expect(parsed.components[0]!.hurdle).toBe('Hurdle requirement: students must pass the exam');
    expect(parsed).not.toHaveProperty('hurdles');
  });

  it('reads a hurdle row that starts with "Hurdle" as a component and keeps later rows', () => {
    const parsed = parseHandbook(table(
      'Hurdle: attendance at 80% of tutorials\tThroughout semester\tN/A',
      'Exam\tEnd of semester\t100%',
    ), { source });
    expect(parsed.components.map(component => [component.name, component.weight]))
      .toEqual([['Hurdle: attendance at 80% of tutorials', undefined], ['Exam', 100]]);
  });

  it('keeps page text after a blank line out of the table and out of the last quote', () => {
    const parsed = parseHandbook(table(
      'Exam\tEnd of semester\t100%',
      '',
      'Note    Late penalty of 10% per day applies',
      'Back to top',
    ), { source });
    expect(parsed.components.map(component => component.name)).toEqual(['Exam']);
    expect(parsed.components[0]!.quote).toBe('Exam\tEnd of semester\t100%');
  });

  it('never reads a Total row as a component', () => {
    const parsed = parseHandbook(table('Assignments\tWeeks 3-10\t30%', 'Exam\tEnd of semester\t70%', 'Total\t\t100%'), { source });
    expect(parsed.components.map(component => component.name)).toEqual(['Assignments', 'Exam']);
  });

  it('keeps a leading empty cell so columns stay aligned with the header', () => {
    const parsed = parseHandbook(['Type\tDescription\tTiming\tPercentage', '\tExam\tEnd of semester\t50%'].join('\n'), { source });
    expect(parsed.components[0]).toMatchObject({ name: 'Exam', timing: 'End of semester', weight: 50 });
  });

  it('does not take a prose line naming all three columns as the table header', () => {
    const parsed = parseHandbook([
      'The description, timing and percentage of each task are below.',
      'Description\tTiming\tPercentage',
      'Assignments\tWeeks 3-10\t30%',
    ].join('\n'), { source });
    expect(parsed.components).toEqual([expect.objectContaining({ name: 'Assignments', weight: 30 })]);
  });

  it('reads the hurdle paragraph after a blank line under its heading', () => {
    const parsed = parseHandbook(table('Exam\tEnd of semester\t100%', '', 'Hurdle requirements', '', 'Students must pass the exam.'), { source });
    expect(parsed.hurdles).toBe('Students must pass the exam.');
    expect(parsed.components[0]!.hurdle).toBe('Students must pass the exam.');
  });
});
