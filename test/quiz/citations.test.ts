import { expect, it } from 'vitest';
import { validateCitedAnswers } from '../../src/quiz/citations.js';
const q = 'ed:7:11:21:31';
const question = { sourceItemId: q, kind: 'question' as const, questionRef: q, text: 'What is parity?', locator: 'question:31' };
const material = { sourceItemId: 'synthetic-material', kind: 'material' as const, text: 'Parity is “even or odd”.', locator: 'page:2', page: 2 };
const sources = [question, material];
const citation = { sourceItemId: q, quote: 'What is parity?', locator: 'question:31' };
const answer = { questionRef: q, answer: 'Parity is "even or odd".', rationale: 'By definition.', citations: [citation, { sourceItemId: material.sourceItemId, quote: 'Parity is "even or odd".', locator: 'page:2' }],
  statements: [{ field: 'answer', text: 'Parity is "even or odd".', kind: 'material', sourceItemId: material.sourceItemId }, { field: 'rationale', text: 'By definition.', kind: 'reasoning' }] };
it('accepts specific question and material citations with checked offsets/page/hash and normalized quotes', () => {
  const checked = validateCitedAnswers([answer], [q], sources);
  expect(checked[0]).toMatchObject({ evidence: 'course-material', validatedCitations: [{ offset: 0, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) }, { offset: 0, page: 2 }] });
  const normalized = { ...question, text: 'Ｗhat\n is   parity?' };
  expect(validateCitedAnswers([{ ...answer, citations: [citation, answer.citations[1]] }], [q], [normalized, material])).toHaveLength(1);
});
it.each(['answer', 'rationale'] as const)('rejects material statements in %s covered only by question provenance', field => {
  const proposal = { ...answer, citations: [citation], answer: field === 'answer' ? answer.answer : 'Even.', rationale: field === 'rationale' ? answer.answer : 'By definition.',
    statements: [{ field, text: answer.answer, kind: 'material', sourceItemId: material.sourceItemId }, { field: field === 'answer' ? 'rationale' : 'answer', text: field === 'answer' ? 'By definition.' : 'Even.', kind: 'reasoning' }] };
  expect(() => validateCitedAnswers([proposal], [q], sources)).toThrow(/citation/i);
});
it('another question or material citation alone cannot replace the answered-question citation', () => {
  const other = { ...question, sourceItemId: 'ed:7:11:21:32', questionRef: 'ed:7:11:21:32' };
  for (const citations of [[answer.citations[1]], [{ ...citation, sourceItemId: other.sourceItemId }, answer.citations[1]]]) {
    expect(() => validateCitedAnswers([{ ...answer, citations }], [q], [...sources, other])).toThrow(/citation/i);
  }
});
it('rejects fabricated source/locator/quote/offset/page and caller source text', () => {
  for (const changed of [{ sourceItemId: 'invented' }, { locator: 'page:9' }, { quote: 'Fabricated fact.' }, { offset: 99 }, { page: 9 }, { text: material.text }]) {
    expect(() => validateCitedAnswers([{ ...answer, citations: [citation, { ...answer.citations[1], ...changed }] }], [q], sources)).toThrow(/citation/i);
  }
});
it('requires exhaustive statement provenance and marks prompt-only reasoning as an evidence limitation', () => {
  const reasoning = { questionRef: q, answer: 'Even.', rationale: 'My calculation.', citations: [citation], statements: [{ field: 'answer', text: 'Even.', kind: 'reasoning' }, { field: 'rationale', text: 'My calculation.', kind: 'reasoning' }] };
  expect(validateCitedAnswers([reasoning], [q], sources)[0]).toMatchObject({ evidence: 'prompt-only', limitation: expect.stringContaining('not correctness') });
  expect(() => validateCitedAnswers([{ ...reasoning, statements: [] }], [q], sources)).toThrow(/citation/i);
  expect(() => validateCitedAnswers([{ ...reasoning, questionRef: 'ed:8:11:21:31' }], [q], sources)).toThrow();
  expect(() => validateCitedAnswers([reasoning, reasoning], [q], sources)).toThrow();
});
it('known material copied into undeclared reasoning still needs material support', () => {
  expect(() => validateCitedAnswers([{ ...answer, citations: [citation], statements: answer.statements.map(s => ({ field: s.field, text: s.text, kind: 'reasoning' })) }], [q], sources)).toThrow(/citation/i);
});
it('rejects inconsistent trusted question identity even when another valid question citation exists', () => {
  const inconsistent = { ...question, sourceItemId: 'ed:7:11:21:32' };
  expect(() => validateCitedAnswers([{ ...answer, citations: [...answer.citations, { ...citation, sourceItemId: inconsistent.sourceItemId }] }], [q], [...sources, inconsistent])).toThrow(/citation/i);
});
it('short copied material statements also require declared material support', () => {
  const short = { ...material, text: 'Parity is even.' };
  const a = { ...answer, answer: short.text, citations: [citation], statements: [{ field: 'answer', text: short.text, kind: 'reasoning' }, answer.statements[1]] };
  expect(() => validateCitedAnswers([a], [q], [question, short])).toThrow(/citation/i);
});
