import { expect, it } from 'vitest';
import { normalizeEdQuestions } from '../../src/sync/ed-questions.js';
import { target } from './ed-scope-fixture.js';
export const question = { id: 31, type: 'multiple-choice', prompt: 'Select the even number.', options: [{ id: 1, text: '2' }, { id: 2, text: '3' }] };
export const payload = (questions: unknown[] = [question], extra: object = {}) => ({ target, lesson: { lesson: { id: 11, slides: [{ id: 21 }] } },
  slides: [{ slide: { id: 21, questions }, ...extra }] });
it('returns stable source/assessment/question refs, recognized content and explicit coverage', () => {
  const result = normalizeEdQuestions(payload());
  expect(result.assessmentRef).toBe('ed:7:11');
  expect(result.coverage).toEqual({ complete: true, scope: 'assessment', total: 1, supported: 1, unsupported: 0 });
  expect(result.questions[0]).toMatchObject({ ref: 'ed:7:11:21:31', type: 'multiple-choice', supported: true, prompt: question.prompt });
  expect(result.sources[0]).toMatchObject({ sourceItemId: 'ed:7:11:21:31', locator: 'question:31', text: expect.stringContaining(question.prompt) });
  expect(normalizeEdQuestions(payload()).questions[0].ref).toBe(result.questions[0].ref);
});
it('never exports author profiles, grades, hidden solutions or classmate answers', () => {
  const unsafe = { author: { name: 'Synthetic Peer' }, grade: 'grade-sentinel', hidden_solution: 'hidden-sentinel', students: [{ answers: 'answer-sentinel' }] };
  const serialized = JSON.stringify(normalizeEdQuestions(payload([{ ...question, ...unsafe }], unsafe)));
  expect(serialized).not.toMatch(/Synthetic Peer|grade-sentinel|hidden-sentinel|answer-sentinel|author|hidden_solution/);
});
it('redacts nested identity fields and free text deterministically before output', () => {
  const result = normalizeEdQuestions(payload([{ id: 31, type: 'text', prompt: 'Synthetic Peer and Synthetic Partner: peer@example.invalid, student number 123456789, +61 412 345 678.' }],
    { nested: [{ author: { name: 'Synthetic Peer' } }, { people: [{ full_name: 'Synthetic Partner' }] }] }));
  const serialized = JSON.stringify(result);
  expect(serialized).not.toMatch(/Synthetic Peer|Synthetic Partner|peer@example.invalid|123456789|412 345 678/);
  expect(result.questions[0]).toMatchObject({ prompt: expect.stringContaining('[redacted]') });
  expect(normalizeEdQuestions(payload([{ id: 31, type: 'text', prompt: 'Synthetic Peer' }], { author: { name: 'Synthetic Peer' } })).sources[0].text).toBe('[redacted]');
});
it('collects identities across lesson and slide boundaries', () => {
  const input = payload([{ id: 31, type: 'text', prompt: 'Synthetic Peer explains parity.' }]);
  input.lesson = { ...input.lesson, people: [{ name: 'Synthetic Peer' }] } as typeof input.lesson;
  expect(JSON.stringify(normalizeEdQuestions(input))).not.toContain('Synthetic Peer');
});
it.each([
  { author: { username: 'synthetic_peer_42' }, prompt: 'synthetic_peer_42 explains parity.', expected: '[redacted] explains parity.' },
  { author: { student_number: '7654321' }, prompt: 'Student number 7654321 explains parity.', expected: 'Student number [redacted] explains parity.' },
  { author: { name: '张三' }, prompt: '同学张三解释了奇偶性。', expected: '同学[redacted]解释了奇偶性。' },
  { author: { studentNumber: 7654321 }, prompt: 'Student number 7654321 explains parity.', expected: 'Student number [redacted] explains parity.' },
  { author: { username: 'synthetic.peer+42' }, prompt: 'synthetic.peer+42 explains parity.', expected: '[redacted] explains parity.' },
  { author: { username: 'ｓｙｎｔｈｅｔｉｃ_peer_42' }, prompt: 'SYNTHETIC_peer_42 explains parity.', expected: '[redacted] explains parity.' },
])('redacts known person identifiers in prompts, options and source text: $author', ({ author, prompt, expected }) => {
  const result = normalizeEdQuestions(payload([{ ...question, prompt, options: [{ id: 1, text: prompt }, { id: 2, text: 'None.' }] }],
    { nested: [{ people: [author] }] }));
  expect(result.questions[0]).toMatchObject({ prompt: expected, options: [{ id: '1', text: expected }, { id: '2', text: 'None.' }] });
  expect(result.sources[0].text).toBe(`${expected}\n1: ${expected}\n2: None.`);
});
it.each([
  { username: { value: 'synthetic_peer_42' } },
  { username: ['synthetic_peer_42'] },
  { student_number: { value: '7654321' } },
  { student_number: 7654321.5 },
])('withholds person identifiers whose format cannot be safely interpreted: %j', author => {
  expect(() => normalizeEdQuestions(payload([{ ...question, prompt: 'synthetic_peer_42 and 7654321 explain parity.' }], { author })))
    .toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
});
it.each([
  'Student number 7654321 explains parity.',
  'ID: 765432 explains parity.',
])('redacts student numbers in free text without a structured identity field: %s', prompt => {
  const result = normalizeEdQuestions(payload([{ ...question, prompt }]));
  expect(JSON.stringify(result)).not.toMatch(/7654321|765432/);
});
it('keeps ordinary numbers that are not labelled as identifiers', () => {
  expect(normalizeEdQuestions(payload([{ ...question, prompt: 'Is 100000 even?' }])).questions[0]).toMatchObject({ prompt: 'Is 100000 even?' });
});
it.each([
  ['prompt', 'Use token: synthetic-secret-value to solve this.'],
  ['prompt', 'api_key=synthetic-secret-value'],
  ['prompt', 'Authorization uses Bearer synthetic-secret-value'],
  ['option', 'secret = synthetic-secret-value'],
])('withholds credential-shaped text in the %s', (where, text) => {
  const q = where === 'prompt' ? { ...question, prompt: text } : { ...question, options: [{ id: 1, text }, { id: 2, text: '3' }] };
  expect(() => normalizeEdQuestions(payload([q]))).toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
});
it('does not treat the word token in course content as a credential', () => {
  expect(normalizeEdQuestions(payload([{ ...question, prompt: 'How many tokens does the lexer emit?' }])).questions[0]).toMatchObject({ supported: true });
});
it('withholds text when the redaction marker would reproduce a known username', () => {
  expect(() => normalizeEdQuestions(payload([{ ...question, prompt: 'redacted explains parity.' }], { author: { username: 'redacted' } })))
    .toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
});
it('marks recognized unknown widgets without exporting their unverified fields', () => {
  const result = normalizeEdQuestions(payload([{ id: 31, type: 'unknown-private-widget', prompt: 'private-sentinel', solution: 'private-sentinel' }]));
  expect(result.questions).toEqual([{ ref: 'ed:7:11:21:31', type: 'unsupported', supported: false }]);
  expect(result.coverage.complete).toBe(false); expect(result.coverage.unsupported).toBe(1);
  expect(result.sources).toEqual([]); expect(JSON.stringify(result)).not.toContain('private-sentinel');
});
it.each([
  [{ type: 'text', prompt: 'Missing identity' }],
  [{ id: 31, type: 'text', prompt: { author: 'unsafe' } }],
  [{ id: 31, type: 'text', prompt: '<script>private-sentinel</script>' }],
  [{ id: 31, type: 'text', prompt: 'Classmate Unknown Person answered this.' }],
  [{ id: 31, type: 'text', prompt: 'authToken:au credential-sentinel' }],
  [{ ...question, options: [{ id: 1, text: 'a' }, { id: 1, text: 'b' }] }],
  [question, question],
].map(questions => ({ questions })))('withholds malformed, unsafe or ambiguous question structure $questions', ({ questions }) => {
  expect(() => normalizeEdQuestions(payload(questions))).toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
});
it('rejects unrecognized lesson/slide structures without raw fallback', () => {
  expect(() => normalizeEdQuestions({ target, lesson: {}, slides: [{ content: '<xml/>' }] })).toThrowError();
});
it('narrows exact question refs with explicit selection scope and refuses unknown refs', () => {
  const input = payload([question, { id: 32, type: 'text', prompt: 'Explain parity.' }]);
  const selected = normalizeEdQuestions({ ...input, target: { ...target, questions: ['ed:7:11:21:32'] } });
  expect(selected.questions.map(q => q.ref)).toEqual(['ed:7:11:21:32']);
  expect(selected.coverage).toMatchObject({ complete: true, scope: 'selection', total: 1 });
  expect(() => normalizeEdQuestions({ ...input, target: { ...target, questions: ['ed:7:11:21:99'] } })).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
});
it.each([{ author: 'Synthetic Peer' }, { people: ['Synthetic Peer'] }, { author: { displayName: 'Synthetic Peer' } }])('redacts string and array identity fields %j', extra => {
  const result = normalizeEdQuestions(payload([{ id: 31, type: 'text', prompt: 'Synthetic Peer explains parity.' }], extra));
  expect(JSON.stringify(result)).not.toContain('Synthetic Peer');
});
it('withholds unrecognized person objects rather than silently losing names', () => {
  expect(() => normalizeEdQuestions(payload([{ id: 31, type: 'text', prompt: 'Synthetic Peer explains parity.' }], { author: { alias: 'Synthetic Peer' } })))
    .toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
});
it('does not treat person ids, answers, grades or partial words as classmate names', () => {
  const result = normalizeEdQuestions(payload([{ ...question, prompt: 'Calculate 1 + 1.' }], {
    author: { id: '1', name: 'Al', avatar: '2' }, students: [{ answers: '2', grade: '3' }],
  }));
  expect(result.questions[0]).toMatchObject({ prompt: 'Calculate 1 + 1.', options: [{ id: '1', text: '2' }, { id: '2', text: '3' }] });
});
