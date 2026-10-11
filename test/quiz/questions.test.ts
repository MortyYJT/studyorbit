import { expect, it } from 'vitest';
import { normalizeQuiz } from '../../src/quiz/read/questions.js';
import { target } from './synthetic.js';
export const question = { id: 31, type: 'multiple-choice', prompt: 'Select the even number.', options: [{ id: 1, text: '2' }, { id: 2, text: '3' }] };
export const payload = (questions: unknown[] = [question], extra: object = {}) => ({ target, lesson: { lesson: { id: 11, slides: [{ id: 21 }] } },
  slides: [{ slide: { id: 21, questions }, ...extra }] });
it('returns stable source/assessment/question refs, recognized content and explicit coverage', () => {
  const result = normalizeQuiz(payload());
  expect(result.assessmentRef).toBe('ed:7:11');
  expect(result.coverage).toEqual({ complete: true, scope: 'assessment', total: 1, supported: 1, unsupported: 0 });
  expect(result.questions[0]).toMatchObject({ ref: 'ed:7:11:21:31', type: 'multiple-choice', supported: true, prompt: question.prompt });
  expect(result.sources[0]).toMatchObject({ sourceItemId: 'ed:7:11:21:31', locator: 'question:31', text: expect.stringContaining(question.prompt) });
  expect(normalizeQuiz(payload()).questions[0].ref).toBe(result.questions[0].ref);
});
it('never exports author profiles, grades, hidden solutions or classmate answers', () => {
  const unsafe = { author: { name: 'Synthetic Peer' }, grade: 'grade-sentinel', hidden_solution: 'hidden-sentinel', students: [{ answers: 'answer-sentinel' }] };
  const serialized = JSON.stringify(normalizeQuiz(payload([{ ...question, ...unsafe }], unsafe)));
  expect(serialized).not.toMatch(/Synthetic Peer|grade-sentinel|hidden-sentinel|answer-sentinel|author|hidden_solution/);
});
it('redacts nested identity fields and free text deterministically before output', () => {
  const result = normalizeQuiz(payload([{ id: 31, type: 'text', prompt: 'Synthetic Peer and Synthetic Partner: peer@example.invalid, student number 123456789, +61 412 345 678.' }],
    { nested: [{ author: { name: 'Synthetic Peer' } }, { people: [{ full_name: 'Synthetic Partner' }] }] }));
  const serialized = JSON.stringify(result);
  expect(serialized).not.toMatch(/Synthetic Peer|Synthetic Partner|peer@example.invalid|123456789|412 345 678/);
  expect(result.questions[0]).toMatchObject({ prompt: expect.stringContaining('[redacted]') });
  expect(normalizeQuiz(payload([{ id: 31, type: 'text', prompt: 'Synthetic Peer' }], { author: { name: 'Synthetic Peer' } })).sources[0].text).toBe('[redacted]');
});
it('collects identities across lesson and slide boundaries', () => {
  const input = payload([{ id: 31, type: 'text', prompt: 'Synthetic Peer explains parity.' }]);
  input.lesson = { ...input.lesson, people: [{ name: 'Synthetic Peer' }] } as typeof input.lesson;
  expect(JSON.stringify(normalizeQuiz(input))).not.toContain('Synthetic Peer');
});
it('marks recognized unknown widgets without exporting their unverified fields', () => {
  const result = normalizeQuiz(payload([{ id: 31, type: 'unknown-private-widget', prompt: 'private-sentinel', solution: 'private-sentinel' }]));
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
  expect(() => normalizeQuiz(payload(questions))).toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
});
it('rejects unrecognized lesson/slide structures without raw fallback', () => {
  expect(() => normalizeQuiz({ target, lesson: {}, slides: [{ content: '<xml/>' }] })).toThrowError();
});
it('narrows exact question refs with explicit selection scope and refuses unknown refs', () => {
  const input = payload([question, { id: 32, type: 'text', prompt: 'Explain parity.' }]);
  const selected = normalizeQuiz({ ...input, target: { ...target, questions: ['ed:7:11:21:32'] } });
  expect(selected.questions.map(q => q.ref)).toEqual(['ed:7:11:21:32']);
  expect(selected.coverage).toMatchObject({ complete: true, scope: 'selection', total: 1 });
  expect(() => normalizeQuiz({ ...input, target: { ...target, questions: ['ed:7:11:21:99'] } })).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
});
it.each([{ author: 'Synthetic Peer' }, { people: ['Synthetic Peer'] }, { author: { displayName: 'Synthetic Peer' } }])('redacts string and array identity fields %j', extra => {
  const result = normalizeQuiz(payload([{ id: 31, type: 'text', prompt: 'Synthetic Peer explains parity.' }], extra));
  expect(JSON.stringify(result)).not.toContain('Synthetic Peer');
});
it('withholds unrecognized person objects rather than silently losing names', () => {
  expect(() => normalizeQuiz(payload([{ id: 31, type: 'text', prompt: 'Synthetic Peer explains parity.' }], { author: { alias: 'Synthetic Peer' } })))
    .toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
});
it('does not treat person ids, answers, grades or partial words as classmate names', () => {
  const result = normalizeQuiz(payload([{ ...question, prompt: 'Calculate 1 + 1.' }], {
    author: { id: '1', name: 'Al', avatar: '2' }, students: [{ answers: '2', grade: '3' }],
  }));
  expect(result.questions[0]).toMatchObject({ prompt: 'Calculate 1 + 1.', options: [{ id: '1', text: '2' }, { id: '2', text: '3' }] });
});
