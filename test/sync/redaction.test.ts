import { expect, it } from 'vitest';
import { createRedactor } from '../../src/sync/redaction.js';
// The API sync's Ed normalization was removed (agent-course-reading); the redactor stays for browser, read and revision code until C-3.
it('4.3 shares canonical whitespace across names, staff exceptions and owner rules', () => {
  const redactor = createRedactor({ author: { name: 'Synthetic  Staff', email: 'staff@example.invalid' }, people: [{ name: 'Synthetic  Person-Z' }] },
    { staffNames: ['Ｓynthetic Staff'], ownerRules: ['Ｐrivate  tag'] });
  expect(redactor.text('Synthetic\nStaff staff@example.invalid Synthetic\nPerson-Z Private\ntag')).toBe('Synthetic\nStaff [redacted] [redacted] [redacted]');
});
it('4.3 redacts eleven-digit numbers even without a harvested phone field', () => {
  expect(createRedactor([]).text('Contact 61400000000')).toBe('Contact [redacted]');
});
it('4.3 harvests nested names across the entire scope before text, title and encoded URL redaction', () => {
  const scope = [{ title: 'Synthetic Person-Z', url: 'https://edstem.org/Synthetic%20Person-Z' },
    { children: [{ authors: [{ display_name: 'Synthetic Person-Z' }], people: [{ name: '测试同学甲' }] }] }];
  const redactor = createRedactor(scope);
  expect(redactor.text('Synthetic Person-Z 测试同学甲')).not.toMatch(/Person-Z|同学甲/);
  expect(redactor.text(scope[0].url!)).not.toContain('Person-Z');
});
it('4.3 owner literals and staff names never exempt emails, student numbers, phones or secrets', () => {
  const redactor = createRedactor([{ author: { name: 'Synthetic Staff' } }], { ownerRules: ['private-tag'], staffNames: ['Synthetic Staff'] });
  const text = redactor.text('Synthetic Staff private-tag staff@example.invalid student number: 1234567 +61 400 000 000');
  expect(text).toContain('Synthetic Staff');
  expect(text).not.toMatch(/private-tag|example|1234567|400/);
  expect(() => redactor.text('Synthetic Staff api_key=synthetic-secret')).toThrowError();
});
it.each([
  { author: { student_id: 123456 }, text: 'Answer from 123456', leak: '123456' },
  { author: { telephone_number: 61400000000 }, text: 'Call 61.400.000.000', leak: '400.000' },
])('4.3 harvests numeric identity aliases or withholds the source: $author', ({ author, text, leak }) => {
  let output = '';
  try { output = createRedactor({ author }).text(text); } catch (error) { expect(error).toMatchObject({ code: 'SOURCE_UNAVAILABLE' }); return; }
  expect(output).not.toContain(leak);
});
it('4.3 withholds unknown primitive person fields regardless of value type', () => {
  expect(() => createRedactor({ author: { badge_number: 998877 } })).toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
});
it('4.3 redacts names encoded with + in URL query strings', () => {
  const output = createRedactor({ author: { name: 'Synthetic Person-Z' } }).text('https://edstem.org/resource?person=Synthetic+Person-Z');
  expect(output).not.toMatch(/Synthetic[+ ]Person-Z/);
});
it.each(['student_id=1234567', 'SID: 1234567', 'Student Number - 1234567', 'student-no 1234567', 'id: 1234567'])(
  'redacts the labelled seven-digit student number in %s', value => {
    expect(createRedactor({}).text(value)).not.toContain('1234567');
  });
it('keeps a seven-digit provider object number in a URL path', () => {
  expect(createRedactor({}).url('https://canvas.example.edu/courses/123/files/1234567')).toContain('/files/1234567');
});
it('redacts long separator-free text in linear time (#71)', () => {
  const started = performance.now();
  createRedactor({}).text('界'.repeat(60000));
  expect(performance.now() - started).toBeLessThan(500);
});
it.each([
  ['mail a.b@example.edu now', 'mail [redacted] now'],
  ['x@y?z=1', '[redacted]?z=1'],
  ['trailing at@ sign', 'trailing at@ sign'],
  ['a@b@ c', '[redacted] c'],
  ['@handle here', '[redacted] here'],
])('keeps email redaction semantics for %s', (input, expected) => {
  expect(createRedactor({}).text(input)).toBe(expected);
});
it('4.5 label-based six digit identifiers, invisible characters and nested URL encoding cannot escape', () => {
  const redactor = createRedactor([{ author: 'Synthetic Person-Z' }]);
  expect(redactor.text('student ID: 123456')).not.toContain('123456');
  expect(() => redactor.text('Synthetic\u200b Person-Z')).toThrowError();
  expect(redactor.text('url: https://edstem.org/Synthetic%2520Person-Z')).not.toContain('Person-Z');
});
