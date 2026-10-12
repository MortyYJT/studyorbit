import { expect, it, vi } from 'vitest';
import { hash } from '../../src/citations/exact.js';
import { StudyCitationService, type StudyEvidenceProvider } from '../../src/protocol/citations.js';
const source = { sourceItemId: 'synthetic-source', courseId: 'synthetic-course', text: 'A synthetic statement.', sourceHash: hash('A synthetic statement.'), locator: 'page:2', page: 2, provenance: 'manual' as const, redacted: true as const };
const citation = { sourceItemId: source.sourceItemId, quote: source.text, locator: source.locator };
const claim = { text: 'A derived claim.', citations: [citation] };
const revision = hash('synthetic-revision');
const target = { courseId: source.courseId, assessmentId: 'synthetic-assessment' };
const inputs = {
  'revision.write': { courseId: source.courseId, sourceRevision: revision, claims: [claim, claim] },
  'practice.write': { courseId: source.courseId, sourceRevision: revision, questions: [{ id: 'practice', prompt: 'Synthetic prompt?', kind: 'open', answer: 'Synthetic answer', explanation: [claim, claim] }] },
  'breakdown.write': { assessmentId: target.assessmentId, sourceRevision: revision, task: { id: 'task', moduleId: 'module', ...target, title: 'Synthetic task', source: 'coursework', steps: [0, 1].map(() => ({ title: 'A derived step', estimateMinutes: 10, done: false, citations: [citation] })) } },
};
function setup(changes = {}) {
  const resolve = vi.fn(async () => ({ target, sourceRevision: revision, sources: [source], ...changes }));
  return { resolve, service: new StudyCitationService({ resolve } satisfies StudyEvidenceProvider) };
}
it.each(Object.keys(inputs) as (keyof typeof inputs)[])('validates every structured unit with trusted target evidence: %s', async command => {
  const { service, resolve } = setup();
  const result = await service.validate(command, inputs[command]);
  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledWith(command === 'breakdown.write' ? target : { courseId: source.courseId });
  expect(result.units).toHaveLength(2);
  expect(result.citations).toHaveLength(2);
  expect(result.citations[0]).toMatchObject({ ...citation, offset: 0, end: source.text.length, sourceHash: source.sourceHash, page: 2 });
  expect(result.limitations).toEqual(['Exact citation membership establishes provenance, not claim correctness.']);
});
it.each(Object.keys(inputs) as (keyof typeof inputs)[])('rejects any uncited or forged unit in %s', async command => {
  for (const bad of [[], [{ ...citation, quote: 'invented' }], [{ ...citation, offset: 999 }], [{ ...citation, text: source.text }], [{ ...citation, page: 2 }]]) {
    const input = structuredClone(inputs[command]);
    if ('claims' in input) input.claims[1]!.citations = bad;
    else if ('questions' in input) input.questions[0]!.explanation[1]!.citations = bad;
    else input.task.steps[1]!.citations = bad;
    await expect(setup().service.validate(command, input)).rejects.toMatchObject({ code: 'CITATION_MISMATCH' });
  }
});
it.each(Object.keys(inputs) as (keyof typeof inputs)[])('fails closed on missing, wrong-course, stale or duplicate evidence: %s', async command => {
  for (const changes of [{ sources: [] }, { sources: [{ ...source, courseId: 'other-course' }] }, { sources: [{ ...source, sourceHash: hash('old') }] },
    { sources: [source, source] }, { target: { ...target, courseId: 'other-course' } }, { sourceRevision: hash('old-revision') }, { sources: [{ ...source, page: 3 }] }]) {
    await expect(setup(changes).service.validate(command, inputs[command])).rejects.toMatchObject({ code: 'CITATION_MISMATCH' });
  }
});
it('requires an independently resolved breakdown assessment binding', async () => {
  await expect(setup({ target: { ...target, assessmentId: 'other-assessment' } }).service.validate('breakdown.write', inputs['breakdown.write'])).rejects.toMatchObject({ code: 'CITATION_MISMATCH' });
});
it('does not accept request-supplied evidence or invent support for nonstudy commands', async () => {
  const { service, resolve } = setup();
  await expect(service.check('revision.write', { ...inputs['revision.write'], sources: [source] })).rejects.toMatchObject({ code: 'CITATION_MISMATCH' });
  expect(resolve).not.toHaveBeenCalled();
  await expect(service.check('quiz.propose', {})).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});
