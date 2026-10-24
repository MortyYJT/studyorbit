import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { dispatch } from '../../src/protocol/registry.js';
import { SyncJobs } from '../../src/sync/jobs.js';
import { courseEvidenceSnapshot, materialIdentity } from '../../src/revision/sources.js';
import { TrustedStoreEvidence } from '../../src/protocol/reads.js';
import { hash } from '../../src/citations/exact.js';
import { component, document, found, item, now, quoted } from '../sync/course-document.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const key = 'SYNA10001:2026:S2';
const prohibited = quoted('prohibited', 'Generative AI tools are not permitted in this subject.');
const quiz = component('quizzes', 100, [item(1)], { kind: found('quiz') });
function setup() {
  const store = new SqliteRepository(':memory:');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ai-policy-')));
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(directory, 'journal')), owner: { assertOwner: async () => {} } });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.saveCourseSelections([{ key, code: 'SYNA10001', term: '2026:S2', pages: {}, offeredAt: now, selected: true }]);
  const jobs = new SyncJobs(store);
  const agent = host.registry.agentTools(host.context);
  const agentCall = (name: string, input: unknown) => dispatch(agent.registry, name, input, agent.context);
  const ownerCall = (name: string, input: unknown) => dispatch(host.registry, name, input, host.context);
  const read = async (doc: Record<string, unknown>) => {
    const job = jobs.open([key]);
    const result = await agentCall('course.import', { jobId: job.id, document: doc });
    store.saveSyncJob({ ...store.loadSyncJob(job.id)!, endedAt: now, outcome: 'OK' });
    expect(result).toMatchObject({ ok: true });
    return { job: store.loadSyncJob(job.id)!, courseId: (result as unknown as { data: { courseId: string } }).data.courseId };
  };
  const autonomy = async (courseId: string) => (await ownerCall('autonomy.read', { courseId }) as unknown as { data: Record<string, any> }).data;
  const coursePolicy = async (courseId: string) => (await agentCall('annotation.read', { entity: 'course', entityId: courseId }) as unknown as { data: { fields: Record<string, any> } }).data.fields.aiPolicy;
  return { store, agentCall, ownerCall, read, autonomy, coursePolicy };
}

describe('one AI policy field per course (coursework-sync, assessment-autonomy, agent-annotations)', () => {
  it('Agent policy annotation refused: annotation.record of a course aiPolicy is rejected and nothing is stored', async () => {
    const f = setup();
    const { courseId } = await f.read(document([quiz]));
    f.store.saveSourceItem({ id: 'syllabus', platform: 'manual', externalId: materialIdentity('https://example.test/syllabus', 1), courseId, kind: 'material',
      title: 'Syllabus', text: 'AI is prohibited.', contentHash: hash('AI is prohibited.'), fetchedAt: now });
    const sourceRevision = courseEvidenceSnapshot(f.store, new TrustedStoreEvidence(f.store), courseId).sourceRevision;
    expect(await f.agentCall('annotation.record', { entity: 'course', entityId: courseId, field: 'aiPolicy', value: 'prohibited', sourceRevision,
      citations: [{ sourceItemId: 'syllabus', quote: 'AI is prohibited.', locator: 'page:1' }] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.store.readAnnotations('course', courseId)).toEqual([]);
  });

  it('Policy read changes: an agent-read prohibited caps the course at once and the run reports the change with its quote', async () => {
    const f = setup();
    const first = await f.read(document([quiz]));
    expect(first.job.results?.[key]?.policyChanged).toBe(false);
    const { job, courseId } = await f.read(document([quiz], { aiPolicy: prohibited }));
    expect(job.results?.[key]?.policyChanged).toBe(true);
    expect(await f.autonomy(courseId)).toMatchObject({ policy: 'prohibited', policyOrigin: 'agent', cap: 0 });
    const list = await f.agentCall('courses.list', {}) as unknown as { data: { items: Record<string, any>[] } };
    expect(list.data.items[0]).toMatchObject({ aiPolicy: 'prohibited', fields: { aiPolicy: { value: 'prohibited', origin: 'agent' } },
      readState: { aiPolicy: { quote: 'Generative AI tools are not permitted in this subject.' } } });
  });

  it('Agent-read policy caps the course: every assessment is L0 and autonomy.check denies writes', async () => {
    const f = setup();
    const { courseId } = await f.read(document([quiz], { aiPolicy: prohibited }));
    expect(await f.ownerCall('autonomy.default.set', { courseId, level: 2 })).toMatchObject({ ok: true });
    const read = await f.autonomy(courseId);
    expect(read.assessments.map((row: { effectiveLevel: number }) => row.effectiveLevel)).toEqual([0]);
    expect(await f.agentCall('autonomy.check', { assessmentId: read.assessments[0].assessmentId, action: 'fill' }))
      .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'course-prohibited' } });
  });

  it('Owner policy kept: an owner allowed stays effective while the agent-read prohibited and its quote are stored', async () => {
    const f = setup();
    const { courseId } = await f.read(document([quiz]));
    expect(await f.ownerCall('autonomy.policy.set', { courseId, status: 'allowed' })).toMatchObject({ ok: true });
    await f.read(document([quiz], { aiPolicy: prohibited }));
    expect(await f.autonomy(courseId)).toMatchObject({ policy: 'allowed', policyOrigin: 'owner', cap: 2 });
    expect(await f.coursePolicy(courseId)).toMatchObject({ value: 'allowed', origin: 'owner' });
    expect(f.store.loadCourse(courseId)).toMatchObject({ aiPolicy: 'prohibited', readState: { aiPolicy: { quote: 'Generative AI tools are not permitted in this subject.' } } });
  });

  it('Owner clears the policy: an owner null lets the agent-read prohibited apply with origin agent', async () => {
    const f = setup();
    const { courseId } = await f.read(document([quiz], { aiPolicy: prohibited }));
    await f.ownerCall('autonomy.policy.set', { courseId, status: 'allowed' });
    expect(await f.ownerCall('autonomy.policy.set', { courseId, status: null })).toMatchObject({ ok: true });
    expect(await f.autonomy(courseId)).toMatchObject({ policy: 'prohibited', policyOrigin: 'agent', cap: 0 });
    expect(await f.coursePolicy(courseId)).toMatchObject({ value: 'prohibited', origin: 'agent' });
    // The same owner value through the owner annotation command; free text is not a policy.
    expect(await f.ownerCall('annotation.owner.record', { entity: 'course', entityId: courseId, field: 'aiPolicy', value: 'allowed' })).toMatchObject({ ok: true });
    expect(await f.coursePolicy(courseId)).toMatchObject({ value: 'allowed', origin: 'owner' });
    expect(await f.ownerCall('annotation.owner.record', { entity: 'course', entityId: courseId, field: 'aiPolicy', value: 'Owner policy text' })).toMatchObject({ ok: false });
  });

  it('an unknown policy stays uncapped (#125) and a later unknown read does not drop a found policy', async () => {
    const f = setup();
    const { courseId } = await f.read(document([quiz]));
    expect(await f.autonomy(courseId)).toMatchObject({ policy: null, policyOrigin: null, cap: 2 });
    await f.read(document([quiz], { aiPolicy: prohibited }));
    await f.read(document([quiz]));
    expect(await f.autonomy(courseId)).toMatchObject({ policy: 'prohibited', policyOrigin: 'agent' });
  });
});
