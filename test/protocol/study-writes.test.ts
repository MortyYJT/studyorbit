import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { hash } from '../../src/citations/exact.js';
import { StudyCitationService, type StudyEvidenceProvider, type StudyTarget } from '../../src/protocol/citations.js';
import { StudyWriteService, InMemoryStudyRecordStore } from '../../src/protocol/study-writes.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { CourseworkError } from '../../src/protocol/errors.js';

const text = 'Synthetic lecture text. Recursion needs a base case.';
const source = { sourceItemId: 'synthetic-source', courseId: 'course-a', text, sourceHash: hash(text), locator: 'page:3', page: 3,
  provenance: 'manual' as const };
const citation = { sourceItemId: source.sourceItemId, quote: 'Recursion needs a base case.', locator: 'page:3' };
const claim = { text: 'Recursive functions need a stopping case.', citations: [citation] };
const revision = hash('synthetic-source-revision');
const assessments: Record<string, string> = { 'assessment-a': 'course-a', 'assessment-b': 'course-b' };
const inputs = {
  'revision.write': { courseId: 'course-a', week: 2, sourceRevision: revision, claims: [claim] },
  'practice.write': { courseId: 'course-a', week: 2, sourceRevision: revision, questions: [{ id: 'practice-1', prompt: 'What does recursion need?',
    kind: 'open', answer: 'A base case.', explanation: [claim] }] },
  'breakdown.write': { assessmentId: 'assessment-a', sourceRevision: revision, task: { id: 'task-1', moduleId: 'module-a', courseId: 'course-a',
    assessmentId: 'assessment-a', title: 'Plan assignment', source: 'coursework', steps: [{ title: 'Review base cases', estimateMinutes: 20, done: false, citations: [citation] }] } },
};
type Command = keyof typeof inputs;
const commands = Object.keys(inputs) as Command[];

/** Host provider resolves the actual assessment course independently of request fields. */
function provider(state: { revision: string; delay?: number; calls?: number } = { revision }) {
  return { resolve: vi.fn(async (target: StudyTarget) => {
    state.calls = (state.calls ?? 0) + 1;
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    const courseId = target.assessmentId !== undefined ? assessments[target.assessmentId] ?? 'unknown' : target.courseId;
    return { target: { courseId, ...(target.assessmentId !== undefined ? { assessmentId: target.assessmentId } : {}) },
      sourceRevision: state.revision, sources: [{ ...source, courseId }] };
  }) } satisfies StudyEvidenceProvider;
}
function setup(state?: { revision: string; delay?: number; calls?: number }) {
  const evidence = provider(state); const store = new InMemoryStudyRecordStore();
  const service = new StudyWriteService({ provider: evidence, store });
  const context = createFakeContext(); context.services = service; context.evidence = new StudyCitationService(evidence);
  return { evidence, store, service, context, registry: createRegistry() };
}

describe('8.1 validated study writes', () => {
  it.each(commands)('%s publishes a validated revision with verified citations and records intent/outcome', async command => {
    const { store, context, registry } = setup();
    const result = await dispatch(registry, command, inputs[command], context);
    expect(result).toMatchObject({ ok: true, data: { sourceRevision: revision, citations: [{ ...citation, offset: text.indexOf(citation.quote),
      end: text.length, sourceHash: source.sourceHash, page: 3 }], limitations: [expect.stringContaining('not claim correctness')] } });
    if (!result.ok) throw new Error('expected success');
    const data = result.data as { id: string; revision: string };
    const stored = await store.current(command, data.id);
    expect(stored).toMatchObject({ revision: data.revision, sourceRevision: revision });
    expect(context.events.map(e => e.phase)).toEqual(['intent', 'outcome']);
    expect(context.runEvents.at(-1)).toMatchObject({ phase: 'outcome', code: 'OK' });
  });

  it.each(commands)('%s replaces only the current revision and preserves prior state on stale or missing previousRevision', async command => {
    const { store, context, registry } = setup();
    const first = await dispatch(registry, command, inputs[command], context);
    if (!first.ok) throw new Error('expected success');
    const { id, revision: firstRevision } = first.data as { id: string; revision: string };
    const before = structuredClone(await store.current(command, id));
    for (const previousRevision of [undefined, '00000000-0000-4000-8000-000000000000']) {
      const input = { ...structuredClone(inputs[command]), ...(previousRevision ? { previousRevision } : {}) };
      expect(await dispatch(registry, command, input, context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(await store.current(command, id)).toEqual(before);
    }
    const next = await dispatch(registry, command, { ...structuredClone(inputs[command]), previousRevision: firstRevision }, context);
    expect(next).toMatchObject({ ok: true });
    expect(await store.current(command, id)).toMatchObject({ previousRevision: firstRevision });
  });

  it('serializes concurrent replacement so exactly one write publishes', async () => {
    const { store, context, registry } = setup({ revision, delay: 20 });
    const results = await Promise.all([0, 1].map(() => dispatch(registry, 'revision.write', inputs['revision.write'], context)));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const failure = results.find(r => !r.ok);
    expect(['LOCKED', 'CONFLICT']).toContain(failure && !failure.ok ? failure.error.code : undefined);
    expect(store.size()).toBe(1);
  });

  it('rejects a source revision that is stale at request time or changes before publication, keeping the previous record', async () => {
    const state = { revision };
    const { store, context, registry } = setup(state);
    const first = await dispatch(registry, 'revision.write', inputs['revision.write'], context);
    if (!first.ok) throw new Error('expected success');
    const { id, revision: accepted } = first.data as { id: string; revision: string };
    const before = structuredClone(await store.current('revision.write', id));
    state.revision = hash('newer-source');
    expect(await dispatch(registry, 'revision.write', { ...inputs['revision.write'], previousRevision: accepted }, context))
      .toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
    expect(context.events.at(-1)).toMatchObject({ phase: 'denial', code: 'CITATION_MISMATCH' });
    expect(context.runEvents.at(-1)).toMatchObject({ phase: 'denial', code: 'CITATION_MISMATCH' });
    // Current at preflight, changed before the publication-time recheck.
    state.revision = revision; let calls = 0;
    const racing = provider(state);
    racing.resolve.mockImplementation(async (target: StudyTarget) => ({ target: { courseId: target.courseId },
      sourceRevision: ++calls === 1 ? revision : hash('changed-mid-write'), sources: [source] }));
    context.evidence = new StudyCitationService(racing);
    context.services = new StudyWriteService({ provider: racing, store });
    expect(await dispatch(registry, 'revision.write', { ...inputs['revision.write'], previousRevision: accepted }, context))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(context.events.at(-1)).toMatchObject({ phase: 'outcome', code: 'CONFLICT' });
    expect(await store.current('revision.write', id)).toEqual(before);
  });

  it.each(commands)('%s retains personal text while preserving citation checks', async command => {
    const { store, context, registry } = setup();
    const input = structuredClone(inputs[command]) as Record<string, unknown>;
    const text = 'Ask alice.sentinel@student.example for help.';
    if (command === 'revision.write') (input.claims as { text: string }[])[0]!.text = text;
    else if (command === 'practice.write') (input.questions as { answer: string }[])[0]!.answer = text;
    else (input.task as { title: string }).title = text;
    const result = await dispatch(registry, command, input, context);
    expect(result).toMatchObject({ ok: true });
    expect(store.size()).toBe(1);
  });

  it('rejects a breakdown whose task.courseId differs from the assessment course resolved by the evidence provider', async () => {
    const { store, context, registry, evidence } = setup();
    const input = structuredClone(inputs['breakdown.write']);
    input.assessmentId = 'assessment-b'; input.task.assessmentId = 'assessment-b';
    expect(await dispatch(registry, 'breakdown.write', input, context)).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
    expect(evidence.resolve).toHaveBeenCalledWith({ courseId: 'course-a', assessmentId: 'assessment-b' });
    await expect(new StudyWriteService({ provider: evidence, store }).write('breakdown.write', input as never, context)).rejects.toMatchObject({ code: 'CITATION_MISMATCH' });
    expect(store.size()).toBe(0);
  });

  it('rechecks L0 revision authorization in the service and preserves state on denial', async () => {
    const { store, context } = setup();
    context.authorization.check = vi.fn(async () => { throw new CourseworkError('INVALID_INPUT', 'denied'); });
    const service = new StudyWriteService({ provider: provider(), store });
    await expect(service.write('revision.write', inputs['revision.write'] as never, context)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(context.authorization.check).toHaveBeenCalledWith('revision.write', 0, expect.anything());
    expect(store.size()).toBe(0);
  });

  it('records a durable failure and keeps prior state when publication fails, and reports uncertainty after a completed write', async () => {
    const { store, context, registry } = setup();
    const first = await dispatch(registry, 'practice.write', inputs['practice.write'], context);
    if (!first.ok) throw new Error('expected success');
    const { id, revision: accepted } = first.data as { id: string; revision: string };
    const before = structuredClone(await store.current('practice.write', id));
    const publish = vi.spyOn(store, 'publish').mockRejectedValueOnce(new Error('disk sentinel'));
    const failed = await dispatch(registry, 'practice.write', { ...inputs['practice.write'], previousRevision: accepted }, context);
    expect(failed).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify([failed, context.events, context.runEvents])).not.toContain('disk sentinel');
    expect(context.runEvents.at(-1)).toMatchObject({ phase: 'outcome', code: 'INTERNAL' });
    expect(await store.current('practice.write', id)).toEqual(before);
    publish.mockRestore();
    context.audit.record = async event => { if (event.phase === 'outcome') throw new Error('audit down'); };
    expect(await dispatch(registry, 'practice.write', { ...inputs['practice.write'], previousRevision: accepted }, context))
      .toMatchObject({ ok: false, error: { code: 'UNCERTAIN', retryable: false } });
    expect((await store.current('practice.write', id) as { revision: string }).revision).not.toBe(accepted);
  });

  it('contains no SQL or model client in the write service', async () => {
    const code = await readFile(new URL('../../src/protocol/study-writes.ts', import.meta.url), 'utf8');
    expect(code).not.toMatch(/node:sqlite|SELECT |INSERT |UPDATE |anthropic|openai|fetch\(/i);
  });
});
