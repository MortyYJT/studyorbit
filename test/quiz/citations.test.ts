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

it.each(['Parity is even or odd', 'PARITY: is\n even / or — odd!', "Parity is even’or’odd", 'Even or odd is the parity.', 'Parity can be even.', 'Parity is even or odd; this follows from my calculation.'])('rejects undeclared meaningful material overlap: %s', text => {
  for (const field of ['answer', 'rationale'] as const) {
    const otherField = field === 'answer' ? 'rationale' : 'answer';
    const proposal = { ...answer, [field]: text, [otherField]: 'My calculation.', citations: [citation], statements: [
      { field, text, kind: 'reasoning' },
      { field: otherField, text: 'My calculation.', kind: 'reasoning' },
    ] };
    expect(() => validateCitedAnswers([proposal], [q], sources)).toThrow(/citation/i);
  }
});
it('cannot hide material reuse by splitting statements or declaring unrelated material in the same field', () => {
  for (const statements of [
    [{ field: 'answer', text: 'Parity is ', kind: 'reasoning' }, { field: 'answer', text: 'even or odd', kind: 'reasoning' }],
    [{ field: 'answer', text: 'Parity is even or odd', kind: 'reasoning' }, { field: 'answer', text: ' By definition.', kind: 'material', sourceItemId: material.sourceItemId }],
  ]) {
    const proposal = { ...answer, answer: statements.map(s => s.text).join(''), statements: [...statements, answer.statements[1]] };
    expect(() => validateCitedAnswers([proposal], [q], sources)).toThrow(/citation/i);
  }
});
it('accepts normalized material reuse when the actual statement declares and cites that material', () => {
  const text = 'Even or odd is the PARITY';
  expect(validateCitedAnswers([{ ...answer, answer: text, statements: [{ ...answer.statements[0], text }, answer.statements[1]] }], [q], sources)[0]?.evidence).toBe('course-material');
});
it('does not infer material reuse from common grammatical words alone', () => {
  const text = 'This is my calculation or my deduction.';
  expect(validateCitedAnswers([{ ...answer, answer: text, citations: [citation], statements: [{ field: 'answer', text, kind: 'reasoning' }, answer.statements[1]] }], [q], sources)[0]?.evidence).toBe('prompt-only');
});

it.each(['⊤ ∨ ⊥ = ⊤.', '⊤∨⊥=⊤', 'It is.', '!!!'])('rejects copied symbolic or otherwise ambiguous material: %s', text => {
  const sourceText = text.startsWith('⊤') ? '⊤ ∨ ⊥ = ⊤.' : text;
  const symbolic = { ...material, text: sourceText };
  const proposal = { ...answer, answer: text, citations: [citation], statements: [{ field: 'answer', text, kind: 'reasoning' }, answer.statements[1]] };
  expect(() => validateCitedAnswers([proposal], [q], [question, symbolic])).toThrow(/citation/i);
  expect(validateCitedAnswers([{ ...proposal, citations: [citation, { ...answer.citations[1], quote: sourceText }], statements: [{ field: 'answer', text, kind: 'material', sourceItemId: material.sourceItemId }, answer.statements[1]] }], [q], [question, symbolic])[0]?.evidence).toBe('course-material');
});
it.each([
  'The notes say the due date falls on the last weekday.',
  'According to the slides, the due date is the last weekday.',
  '课件里说截止日期是最后一个工作日。',
])('rejects reasoning that attributes a claim to course material without a material citation: %s', text => {
  const deadline = { ...material, text: 'The quiz deadline is Friday.' };
  const proposal = { questionRef: q, answer: 'Friday.', rationale: text, citations: [citation],
    statements: [{ field: 'answer', text: 'Friday.', kind: 'reasoning' }, { field: 'rationale', text, kind: 'reasoning' }] };
  expect(() => validateCitedAnswers([proposal], [q], [question, deadline])).toThrow(/citation/i);
});
it('accepts a statement backed by one of several materials that contain the same sentence', () => {
  const copy = { ...material, sourceItemId: 'synthetic-material-copy', locator: 'page:3', page: 3 };
  const cited = { ...answer, citations: [...answer.citations, { sourceItemId: copy.sourceItemId, quote: 'Parity is "even or odd".', locator: 'page:3' }] };
  expect(validateCitedAnswers([cited], [q], [question, material, copy])[0]).toMatchObject({ evidence: 'course-material' });
});

it('cannot hide explicit material attribution across reasoning statement boundaries', () => {
  const text = 'According to the notes, the deadline falls on the last weekday.';
  const proposal = { questionRef: q, answer: 'Friday.', rationale: text, citations: [citation], statements: [
    { field: 'answer', text: 'Friday.', kind: 'reasoning' },
    { field: 'rationale', text: 'According to the ', kind: 'reasoning' },
    { field: 'rationale', text: 'notes, the deadline falls on the last weekday.', kind: 'reasoning' },
  ] };
  expect(() => validateCitedAnswers([proposal], [q], [question])).toThrow(/citation/i);
});
it('accepts unattributed paraphrase only with an explicit prompt-only limitation', () => {
  const deadline = { ...material, text: 'The quiz deadline is Friday.' };
  const proposal = { questionRef: q, answer: 'The last weekday.', rationale: 'My deduction.', citations: [citation], statements: [
    { field: 'answer', text: 'The last weekday.', kind: 'reasoning' }, { field: 'rationale', text: 'My deduction.', kind: 'reasoning' },
  ] };
  expect(validateCitedAnswers([proposal], [q], [question, deadline])[0]).toMatchObject({ evidence: 'prompt-only', limitation: expect.stringContaining('not correctness') });
});
it('Q1 facade preserves original offsets and v1 source shape on normalized repeated fragments', () => {
  const text = '😀  Ｗhat\n is   parity? What is parity?';
  const proposal = { questionRef: q, answer: 'Even.', rationale: 'My deduction.', citations: [citation], statements: [
    { field: 'answer', text: 'Even.', kind: 'reasoning' }, { field: 'rationale', text: 'My deduction.', kind: 'reasoning' },
  ] };
  expect(validateCitedAnswers([proposal], [q], [{ ...question, text }])[0]?.validatedCitations[0]).toMatchObject({ offset: 4, end: text.indexOf('?') + 1, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
});
