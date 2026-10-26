import { afterEach, expect, it, vi } from 'vitest';
import { AssessmentAutonomy, required, cap, effective } from '../../src/protocol/autonomy.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import type { TrustedContext } from '../../src/protocol/context.js';
import { httpCommandContext } from '../../src/protocol/http.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
import { CanonicalAuthorizationStore } from '../../src/protocol/canonical-authorization.js';
import { synthetic } from '../fixtures/synthetic.js';
import { hash } from '../../src/citations/exact.js';
const stores: SqliteRepository[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
function setup() {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  store.saveBatch({ modules: [synthetic.module], courses: [synthetic.course], assessments: synthetic.assessments });
  const context = createFakeContext({ owner: true });
  const service = new AssessmentAutonomy(store, context.audit);
  const registry = createRegistry({ autonomy: service });
  const call = (name: string, input: unknown, ctx: TrustedContext = context) => dispatch(registry, name, input, ctx);
  return { store, context, service, registry, call };
}
const courseId = synthetic.course.id;
const writes = [
  ['autonomy.policy.set', { courseId, status: 'allowed' }],
  ['autonomy.policy.set', { courseId, assessmentId: 'd', value: 'allowed' }],
  ['autonomy.default.set', { courseId, level: 1 }],
  ['autonomy.override.set', { assessmentId: 'd', level: 2 }],
  ['autonomy.override.clear', { assessmentId: 'd' }],
] as const;
it('required kind, cap and effective level follow work type, not browser action', () => {
  expect(['quiz', 'ongoing', 'participation', 'assignment', 'presentation', 'ungraded', 'exam', undefined].map(kind => required(kind))).toEqual([1, 1, 1, 2, 2, 2, 2, 2]);
  expect(cap('prohibited')).toBe(0); expect(cap(undefined)).toBe(2);
  expect(effective(1, 2, 'prohibited')).toBe(0);
  expect(effective(1, 2, undefined)).toBe(2);
  expect(effective(2, 0, 'allowed')).toBe(0);
});
it('prohibited caps L2 overrides at L0; clearing policy restores the uncapped override', async () => {
  const { call, context } = setup();
  await call('autonomy.override.set', { assessmentId: 'd', level: 2 });
  await call('autonomy.policy.set', { courseId, status: 'prohibited' });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' })).toMatchObject({ ok: true, data: { decision: 'denied', reason: 'course-prohibited' } });
  expect(context.events.at(-1)).toMatchObject({ courseId, assessmentId: 'd', level: 0, decision: 'denied' });
  await call('autonomy.policy.set', { courseId, status: null });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'submit' })).toMatchObject({ ok: true, data: { decision: 'allowed' } });
});
it('owner L1 default allows quizzes and participation work, but assignments require L2', async () => {
  const { call, store } = setup();
  await call('autonomy.policy.set', { courseId, status: 'allowed' });
  await call('autonomy.default.set', { courseId, level: 1 });
  for (const kind of ['quiz', 'ongoing', 'participation', 'assignment'] as const) {
    store.saveAssessment({ ...synthetic.assessments[3]!, kind });
    expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' }))
      .toMatchObject({ ok: true, data: { decision: kind === 'assignment' ? 'denied' : 'allowed' } });
  }
});
it('exam and unknown need L2 without a separate denial; another assessment override is ignored', async () => {
  const { call, store } = setup();
  await call('autonomy.default.set', { courseId, level: 2 });
  await call('autonomy.override.set', { assessmentId: 'a', level: 0 });
  for (const kind of ['exam', undefined] as const) {
    store.saveAssessment({ ...synthetic.assessments[3]!, kind });
    expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' })).toMatchObject({ ok: true, data: { decision: 'allowed' } });
  }
});
it('an override can raise or lower the default and clear returns to the course default', async () => {
  const { call } = setup();
  await call('autonomy.default.set', { courseId, level: 0 });
  await call('autonomy.override.set', { assessmentId: 'd', level: 2 });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' })).toMatchObject({ data: { decision: 'allowed' } });
  await call('autonomy.default.set', { courseId, level: 2 });
  await call('autonomy.override.set', { assessmentId: 'd', level: 0 });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' })).toMatchObject({ data: { decision: 'denied' } });
  await call('autonomy.override.clear', { assessmentId: 'd' });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' })).toMatchObject({ data: { decision: 'allowed' } });
});
it('agent policy suggestions are not authority; effective kind follows owner then agent then sync', async () => {
  const { store, call } = setup();
  await call('autonomy.default.set', { courseId, level: 1 });
  const annotation = { id: 'suggestion', entity: 'assessment' as const, entityId: 'd', field: 'kind', value: 'quiz', origin: 'agent' as const,
    citations: [{ sourceItemId: 's', quote: 'Synthetic', locator: '1' }], at: '2026-01-01T00:00:00Z' };
  store.appendAnnotation(annotation);
  store.appendAnnotation({ ...annotation, id: 'policy-suggestion', entity: 'course', entityId: courseId, field: 'aiPolicy', value: 'prohibited' });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' })).toMatchObject({ data: { decision: 'allowed' } });
  store.appendAnnotation({ ...annotation, id: 'owner-kind', origin: 'owner', value: 'assignment', citations: [] });
  store.appendAnnotation({ ...annotation, id: 'later-agent' });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' })).toMatchObject({ data: { decision: 'denied' } });
});
it.each(writes)('%s persists owner changes and audits the trusted target without prose', async (name, input) => {
  const { call, context, store } = setup();
  expect(await call(name, input)).toMatchObject({ ok: true, data: { recorded: true } });
  expect(context.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ command: name, courseId, phase: 'intent' }),
    expect.objectContaining({ command: name, courseId, phase: 'outcome' }),
  ]));
  expect(store.readCourseAutonomy(courseId).length + store.readAnnotations('course', courseId).length + store.readAnnotations('assessment', 'd').length).toBe(1);
});
it.each(writes)('%s refuses agent HTTP, agent tools, non-TTY and TTY with no mutation', async (name, input) => {
  const { call, registry, context, store } = setup();
  expect(await call(name, input, httpCommandContext(context, name, false, () => false))).toMatchObject({ ok: false });
  const agent = registry.agentTools(context);
  expect(agent.registry.get(name)).toBeUndefined();
  expect(await dispatch(agent.registry, name, input, agent.context)).toMatchObject({ ok: false });
  for (const isTTY of [false, true]) {
    const out: string[] = [];
    const args = name.split('.').concat(Object.entries(input).flatMap(([key, value]) => ['--' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), String(value)]));
    await parseProtocolCLI(args, { registry, context, isTTY, stdout: s => out.push(s), stderr: () => {} });
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false });
  }
  expect(store.readCourseAutonomy(courseId)).toEqual([]);
  expect(store.readAnnotations('course', courseId)).toEqual([]); expect(store.readAnnotations('assessment', 'd')).toEqual([]);
});
it('the confirm-before-submit command is gone and autonomy.read no longer reports it', async () => {
  const { registry, call } = setup();
  expect(registry.get('autonomy.confirmation.set')).toBeUndefined();
  expect(await call('autonomy.confirmation.set', { courseId, confirmBeforeSubmit: false })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(await readData(call)).not.toHaveProperty('confirmBeforeSubmit');
});
it('audit.record is absent and an agent cannot fabricate a browser action', async () => {
  const { registry, context } = setup();
  expect(registry.get('audit.record')).toBeUndefined();
  const agent = registry.agentTools(context);
  expect(await dispatch(agent.registry, 'audit.record', { assessmentId: 'd', action: 'submit', confirmation: 'owner-ui' }, agent.context)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(context.events.some(event => event.action || event.confirmation)).toBe(false);
});
it('audit unavailable denies even with both journals broken; settings do not change before intent audit', async () => {
  const { registry, service, context, store } = setup();
  context.audit.record = context.runs.record = vi.fn(async () => { throw Error('private failure'); });
  const broken = createRegistry({ autonomy: new AssessmentAutonomy(store, context.audit) });
  expect(await dispatch(broken, 'autonomy.check', { assessmentId: 'd', action: 'fill' }, context))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'audit-unavailable' } });
  expect(await dispatch(broken, 'autonomy.default.set', { courseId, level: 2 }, context)).toMatchObject({ ok: false });
  expect(store.readCourseAutonomy(courseId)).toEqual([]);
  expect(service.settings(courseId).defaultLevel).toBe(0);
  expect(registry.get('autonomy.check')).toBeDefined();
});
it('unresolved targets and invalid inputs omit request text from audits', async () => {
  const { call, context } = setup();
  expect(await call('autonomy.check', { assessmentId: 'Synthetic.Person/answer-42', action: 'fill' })).toMatchObject({ data: { decision: 'denied', reason: 'assessment-unavailable' } });
  expect(await call('autonomy.check', { assessmentId: 'private prose', action: 'fill' })).toMatchObject({ ok: false });
  expect(JSON.stringify(context.events)).not.toMatch(/Synthetic.Person|private prose/);
});

it('owner setting audits link the before and after authorization versions and effective level', async () => {
  const { call, context, store } = setup();
  await call('autonomy.policy.set', { courseId, status: 'allowed' });
  const policyRef = hash(store.readAnnotations('course', courseId).at(-1)!);
  await call('autonomy.default.set', { courseId, level: 1 });
  const defaultRef = hash(store.readCourseAutonomy(courseId).at(-1)!);
  expect(context.events.at(-1)).toMatchObject({ courseId, level: 1, policyRef, grantRef: defaultRef });
  await call('autonomy.override.set', { assessmentId: 'd', level: 2 });
  const overrideRef = hash(store.readAnnotations('assessment', 'd').at(-1)!);
  expect(context.events.at(-2)).toMatchObject({ courseId, assessmentId: 'd', phase: 'intent', level: 1, policyRef, grantRef: defaultRef });
  expect(context.events.at(-1)).toMatchObject({ courseId, assessmentId: 'd', phase: 'outcome', level: 2, policyRef, grantRef: overrideRef });
  await call('autonomy.override.clear', { assessmentId: 'd' });
  expect(context.events.at(-1)).toMatchObject({ level: 1, policyRef, grantRef: defaultRef });
  await call('autonomy.policy.set', { courseId, status: 'prohibited' });
  const prohibitedRef = hash(store.readAnnotations('course', courseId).at(-1)!);
  expect(context.events.at(-1)).toMatchObject({ level: 0, policyRef: prohibitedRef });
  await call('autonomy.check', { assessmentId: 'd', action: 'fill' });
  expect(context.events.at(-1)).toMatchObject({ level: 0, policyRef: prohibitedRef, grantRef: defaultRef });
});

it('concurrent owner settings audit each call’s own persisted authorization version', async () => {
  const { call, context, store } = setup();
  const results = await Promise.all([2, 0].map(level => call('autonomy.override.set', { assessmentId: 'd', level })));
  const versions = store.readAnnotations('assessment', 'd');
  for (const [index, level] of [2, 0].entries()) {
    const result = results[index]!;
    expect(result.ok).toBe(true);
    const event = context.events.find(row => row.runId === result.meta?.runId && row.phase === 'outcome');
    expect(event).toMatchObject({ level, grantRef: hash(versions.find(row => row.value === level)!) });
  }
});

type ReadRow = { assessmentId: string };
const readData = async (call: ReturnType<typeof setup>['call']) => {
  const result = await call('autonomy.read', { courseId });
  expect(result).toMatchObject({ ok: true });
  return (result as { data: { assessments: ReadRow[] } & Record<string, unknown> }).data;
};
const row = (data: { assessments: ReadRow[] }, id: string) => data.assessments.find(item => item.assessmentId === id);
it('autonomy.read locks a prohibited course at L0 even under an L2 default and override', async () => {
  const { call } = setup();
  await call('autonomy.default.set', { courseId, level: 2 });
  await call('autonomy.override.set', { assessmentId: 'd', level: 2 });
  await call('autonomy.policy.set', { courseId, status: 'prohibited' });
  const data = await readData(call);
  expect(data).toMatchObject({ courseId, policy: 'prohibited', cap: 0, defaultLevel: 2 });
  expect(row(data, 'd')).toEqual({ assessmentId: 'd', kind: 'assignment', applicable: true, requiredLevel: 2, override: 2, effectiveLevel: 0,
    policy: 'prohibited', policyOrigin: 'owner', policyLevel: 'course', effectivePolicy: { value: 'prohibited', origin: 'owner', level: 'course' } });
});
it('autonomy.read leaves a course with no recorded policy uncapped', async () => {
  const { call } = setup();
  await call('autonomy.default.set', { courseId, level: 2 });
  const data = await readData(call);
  expect(data).toMatchObject({ policy: null, cap: 2, defaultLevel: 2 });
  expect(row(data, 'a')).toMatchObject({ override: null, effectiveLevel: 2 });
});
it('autonomy.read caps an override above the course cap, matching autonomy.check', async () => {
  const { call } = setup();
  await call('autonomy.policy.set', { courseId, status: 'prohibited' });
  await call('autonomy.override.set', { assessmentId: 'a', level: 1 });
  expect(row(await readData(call), 'a')).toMatchObject({ override: 1, effectiveLevel: 0 });
  await call('autonomy.policy.set', { courseId, status: 'allowed' });
  expect(row(await readData(call), 'a')).toMatchObject({ override: 1, effectiveLevel: 1 });
});
it('autonomy.read gives exams no level and follows the effective kind for the required level', async () => {
  const { call, store } = setup();
  await call('autonomy.default.set', { courseId, level: 2 });
  store.saveAssessment({ ...synthetic.assessments[0]!, kind: 'quiz' });
  const data = await readData(call);
  expect(row(data, 'final')).toEqual({ assessmentId: 'final', kind: 'exam', applicable: false, requiredLevel: null, override: null, effectiveLevel: null,
    policy: null, policyOrigin: null, policyLevel: null, effectivePolicy: { value: 'unknown', origin: 'none', level: 'none' } });
  expect(row(data, 'a')).toMatchObject({ kind: 'quiz', applicable: true, requiredLevel: 1, effectiveLevel: 2 });
  expect(data.assessments.map(item => item.assessmentId)).toEqual(['a', 'b', 'c', 'd', 'final']);
});
it('autonomy.read writes no audit rows, is an anonymous agent read and refuses unknown courses', async () => {
  const { call, context, registry } = setup();
  await call('autonomy.override.set', { assessmentId: 'd', level: 1 });
  const before = context.events.length;
  const agent = registry.agentTools(context);
  expect(agent.registry.get('autonomy.read')).toBeDefined();
  expect(await dispatch(agent.registry, 'autonomy.read', { courseId }, agent.context)).toMatchObject({ ok: true });
  expect(await call('autonomy.read', { courseId }, httpCommandContext(context, 'autonomy.read', false, () => false))).toMatchObject({ ok: true });
  await readData(call);
  expect(context.events.length).toBe(before);
  expect(await call('autonomy.read', { courseId: 'missing' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(context.events.length).toBe(before);
});

it('canonical authorization maps participation to the existing ongoing category', async () => {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  store.saveBatch({ modules: [synthetic.module], courses: [synthetic.course], assessments: synthetic.assessments });
  store.saveAssessment({ ...synthetic.assessments[0]!, kind: 'participation' });
  const authorization = new CanonicalAuthorizationStore({} as never, store);
  expect(await authorization.target(synthetic.assessments[0]!.id)).toMatchObject({ category: 'ongoing' });
});
