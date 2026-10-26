import { afterEach, expect, it } from 'vitest';
import { AssessmentAutonomy } from '../../src/protocol/autonomy.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import type { TrustedContext } from '../../src/protocol/context.js';
import { synthetic } from '../fixtures/synthetic.js';

const stores: SqliteRepository[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
const courseId = synthetic.course.id;
function setup() {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  store.saveBatch({ modules: [synthetic.module], courses: [synthetic.course], assessments: synthetic.assessments });
  const context = createFakeContext({ owner: true });
  const service = new AssessmentAutonomy(store, context.audit);
  const registry = createRegistry({ autonomy: service });
  const call = (name: string, input: unknown, ctx: TrustedContext = context) => dispatch(registry, name, input, ctx);
  return { store, context, service, registry, call };
}
const data = async (result: Promise<{ ok: boolean; data?: unknown }>): Promise<Record<string, any>> => {
  const value = await result;
  expect(value).toMatchObject({ ok: true });
  if (!value.ok || !value.data) throw new Error(JSON.stringify(value));
  return value.data as Record<string, any>;
};
const row = (read: Record<string, any>, assessmentId: string) => read.assessments.find((item: { assessmentId: string }) => item.assessmentId === assessmentId);

it('Missing policy or prohibited course: a prohibited course caps an L2 override at L0; no policy leaves it at L2', async () => {
  const { call, service } = setup();
  await call('autonomy.default.set', { courseId, level: 2 });
  await call('autonomy.override.set', { assessmentId: 'd', level: 2 });
  await call('autonomy.policy.set', { courseId, value: 'prohibited' });
  expect(service.policy(courseId, 'd')).toMatchObject({ value: 'prohibited', origin: 'owner', level: 'course' });
  expect(row(await data(call('autonomy.read', { courseId })), 'd')).toMatchObject({ override: 2, effectiveLevel: 0 });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' }))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'course-prohibited' } });
  await call('autonomy.policy.set', { courseId, value: null });
  expect(service.policy(courseId, 'd')).toEqual({ value: 'unknown', origin: 'none', level: 'none' });
  expect(row(await data(call('autonomy.read', { courseId })), 'd')).toMatchObject({ override: 2, effectiveLevel: 2 });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' }))
    .toMatchObject({ ok: true, data: { decision: 'allowed' } });
});

it('Exam or mismatched grant: an exam needs L2 and another assessment override has no effect', async () => {
  const { call, store, service } = setup();
  await call('autonomy.default.set', { courseId, level: 2 });
  await call('autonomy.override.set', { assessmentId: 'a', level: 0 });
  store.saveAssessment({ ...synthetic.assessments[3]!, kind: 'exam' });
  expect(service.policy(courseId, 'd')).toEqual({ value: 'unknown', origin: 'none', level: 'none' });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' }))
    .toMatchObject({ ok: true, data: { decision: 'allowed' } });
  expect(await call('autonomy.check', { assessmentId: 'a', action: 'fill' }))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'grant-level' } });
});

it('Owner attestation is recorded: an owner L1 default allows quizzes, denies assignments and performs no browser action', async () => {
  const { call, context, store } = setup();
  await call('autonomy.policy.set', { courseId, value: 'allowed' });
  await call('autonomy.default.set', { courseId, level: 1 });
  store.saveAssessment({ ...synthetic.assessments[3]!, kind: 'quiz' });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' }))
    .toMatchObject({ ok: true, data: { decision: 'allowed' } });
  store.saveAssessment({ ...synthetic.assessments[3]!, kind: 'assignment' });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' }))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'grant-level' } });
  expect(context.actionCalls).toEqual([]);
  expect(context.events.every(event => event.action === undefined && event.confirmation === undefined)).toBe(true);
});

it('Agent tries to raise a level: an assessment policy command without the owner session is refused and nothing changes', async () => {
  const { call, registry, store } = setup();
  const agent = registry.agentTools(createFakeContext({ owner: true }));
  expect(agent.registry.get('autonomy.policy.set')).toBeUndefined();
  expect(await dispatch(agent.registry, 'autonomy.policy.set', { courseId, assessmentId: 'd', value: 'allowed' }, agent.context))
    .toMatchObject({ ok: false });
  expect(await call('autonomy.policy.set', { courseId, assessmentId: 'd', value: 'allowed' },
    createFakeContext({ owner: false }) as TrustedContext)).toMatchObject({ ok: false });
  expect(store.readAnnotations('assessment', 'd')).toEqual([]);
});

it('Agent-read policy caps the course: a prohibited course policy makes every assessment L0 and reports course level', async () => {
  const { call, store, service } = setup();
  store.saveCourse({ ...synthetic.course, aiPolicy: 'prohibited' });
  await call('autonomy.default.set', { courseId, level: 2 });
  expect(service.policy(courseId)).toEqual({ value: 'prohibited', origin: 'agent', level: 'course' });
  const read = await data(call('autonomy.read', { courseId }));
  expect(read).toMatchObject({ policy: 'prohibited', policyOrigin: 'agent', policyLevel: 'course', cap: 0 });
  // Exams carry no level (#126, #146); every other assessment is capped at L0.
  expect(read.assessments.map((item: { effectiveLevel: number | null }) => item.effectiveLevel)).toEqual([0, 0, 0, 0, null]);
  expect(row(read, 'a')).toMatchObject({ policy: 'prohibited', policyOrigin: 'agent', policyLevel: 'course' });
  expect(await call('autonomy.check', { assessmentId: 'a', action: 'fill' }))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'course-prohibited' } });
});

it('One assessment prohibited: an item banned by the agent is L0 with assessment-prohibited while the others stay L2', async () => {
  const { call, store, service } = setup();
  store.saveCourse({ ...synthetic.course, aiPolicy: 'allowed' });
  store.saveAssessment({ ...synthetic.assessments[3]!, name: 'Report', aiPolicy: 'prohibited' });
  await call('autonomy.default.set', { courseId, level: 2 });
  expect(service.policy(courseId, 'd')).toEqual({ value: 'prohibited', origin: 'agent', level: 'assessment' });
  const read = await data(call('autonomy.read', { courseId }));
  expect(row(read, 'd')).toMatchObject({ policy: 'prohibited', policyOrigin: 'agent', policyLevel: 'assessment', effectiveLevel: 0 });
  expect(row(read, 'a')).toMatchObject({ policy: 'allowed', policyOrigin: 'agent', policyLevel: 'course', effectiveLevel: 2 });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' }))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'assessment-prohibited' } });
});

it('Item allowed does not lift a course ban: an agent-allowed item under a prohibited course stays prohibited', async () => {
  const { call, store, service } = setup();
  store.saveCourse({ ...synthetic.course, aiPolicy: 'prohibited' });
  store.saveAssessment({ ...synthetic.assessments[3]!, aiPolicy: 'allowed' });
  expect(service.policy(courseId, 'd')).toEqual({ value: 'prohibited', origin: 'agent', level: 'course' });
  expect(row(await data(call('autonomy.read', { courseId })), 'd'))
    .toMatchObject({ policy: 'prohibited', policyOrigin: 'agent', policyLevel: 'course', effectiveLevel: 0 });
});

it('Owner assessment policy is final: an owner allowed item beats a prohibited course; the others stay prohibited', async () => {
  const { call, store, service } = setup();
  store.saveCourse({ ...synthetic.course, aiPolicy: 'prohibited' });
  await call('autonomy.default.set', { courseId, level: 2 });
  await call('autonomy.policy.set', { courseId, assessmentId: 'd', value: 'allowed' });
  expect(service.policy(courseId, 'd')).toEqual({ value: 'allowed', origin: 'owner', level: 'assessment' });
  expect(service.policy(courseId, 'a')).toEqual({ value: 'prohibited', origin: 'agent', level: 'course' });
  const read = await data(call('autonomy.read', { courseId }));
  expect(row(read, 'd')).toMatchObject({ policy: 'allowed', policyOrigin: 'owner', policyLevel: 'assessment', effectiveLevel: 2 });
  expect(row(read, 'a')).toMatchObject({ policy: 'prohibited', policyOrigin: 'agent', policyLevel: 'course', effectiveLevel: 0 });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' }))
    .toMatchObject({ ok: true, data: { decision: 'allowed' } });
  expect(await call('autonomy.check', { assessmentId: 'a', action: 'fill' }))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'course-prohibited' } });
});

it('Unknown item policy: no known course or item policy is unknown with an L2 cap', async () => {
  const { call, service } = setup();
  await call('autonomy.default.set', { courseId, level: 2 });
  expect(service.policy(courseId)).toEqual({ value: 'unknown', origin: 'none', level: 'none' });
  expect(service.policy(courseId, 'd')).toEqual({ value: 'unknown', origin: 'none', level: 'none' });
  const read = await data(call('autonomy.read', { courseId }));
  expect(read).toMatchObject({ policy: null, policyOrigin: null, cap: 2 });
  expect(row(read, 'd')).toMatchObject({ policy: null, policyOrigin: null, policyLevel: null, effectiveLevel: 2 });
});

it('Owner clears the course policy: null clears the owner value and the agent-read prohibited applies with origin agent', async () => {
  const { call, store, service } = setup();
  store.saveCourse({ ...synthetic.course, aiPolicy: 'prohibited' });
  await call('autonomy.policy.set', { courseId, value: 'allowed' });
  await call('autonomy.policy.set', { courseId, value: null });
  expect(service.policy(courseId)).toEqual({ value: 'prohibited', origin: 'agent', level: 'course' });
  expect(await data(call('autonomy.read', { courseId })))
    .toMatchObject({ policy: 'prohibited', policyOrigin: 'agent', policyLevel: 'course', cap: 0 });
});

it('Refuses a policy set for another course assessment: NOT_FOUND and nothing is stored', async () => {
  const { call, store } = setup();
  store.saveCourse({ ...synthetic.course, id: 'other', code: 'SYNO10001', name: 'Other synthetic course' });
  store.saveAssessment({ id: 'foreign', courseId: 'other', name: 'Foreign synthetic assessment', weight: 10, isFinal: false, status: 'not_started' });
  expect(await call('autonomy.policy.set', { courseId, assessmentId: 'foreign', value: 'allowed' }))
    .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(store.readAnnotations('assessment', 'foreign')).toEqual([]);
  expect(store.readAnnotations('course', courseId)).toEqual([]);
  expect(store.readAnnotations('course', 'other')).toEqual([]);
});
