import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch } from '../../src/protocol/registry.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
import { synthetic } from '../fixtures/synthetic.js';
const roots: string[] = []; const closes: (() => void)[] = [];
afterEach(async () => { closes.splice(0).forEach(close => close()); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'protocol-production-'))); roots.push(home); vi.stubEnv('COURSEWORK_HOME', home);
  const host = createProductionProtocol({ owner: { assertOwner: async () => {} } }); closes.push(host.close);
  host.store.saveBatch({ modules: [synthetic.module], courses: [synthetic.course], assessments: synthetic.assessments });
  return host;
}
it.each(['autonomy.check', 'audit.record'])('omits unresolved name/answer-like IDs from durable %s audit', async command => {
  const host = await setup();
  const assessmentId = 'Jane.Doe/answer-is-42';
  const input = command === 'autonomy.check' ? { assessmentId, level: 3 }
    : { assessmentId, level: 3, action: 'fill', outcome: 'success' };
  const result = await dispatch(host.registry, command, input, host.context);
  const raw = await readFile(join(process.env.COURSEWORK_HOME!, 'quiz', 'audit.jsonl'), 'utf8');
  expect(raw).not.toContain(assessmentId);
  const events = (await host.audit.list()).filter(event => event.command === command);
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) expect(event).not.toHaveProperty('assessmentId');
  if (command === 'autonomy.check') {
    expect(result).toMatchObject({ ok: true, data: { decision: 'denied', reason: 'assessment-unavailable' } });
    expect(events).toContainEqual(expect.objectContaining({ level: 3, decision: 'denied', code: 'INVALID_INPUT' }));
  } else {
    expect(result).toMatchObject({ ok: true, data: { recorded: true, outcome: 'failure' } });
    expect(events).toContainEqual(expect.objectContaining({ level: 3, action: 'fill', outcome: 'failure', code: 'INVALID_INPUT' }));
  }
});
it('production CLI reads real SQLite, uses private journals and survives reopen', async () => {
  const host = await setup(); const stdout: string[] = [];
  await parseProtocolCLI(['courses', 'list', '--json'], { ...host, stdout: value => stdout.push(value) });
  expect(stdout).toHaveLength(1); expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, data: { items: [synthetic.course] } });
  expect(await host.audit.list()).toHaveLength(2);
  host.close(); const next = createProductionProtocol(); closes.push(next.close);
  expect(await dispatch(next.registry, 'courses.list', {}, next.context)).toMatchObject({ ok: true, data: { items: [synthetic.course] } });
});
it('owner terminal records canonical policy and grant; live revocation takes effect', async () => {
  const host = await setup();
  const call = (name: string, input: unknown) => dispatch(host.registry, name, input, host.context);
  const policy = { version: 1, courseId: synthetic.course.id, status: 'owner-attested', attestation: 'Synthetic only', date: '2026-10-14', cap: 4 };
  const grant = { version: 1, courseId: synthetic.course.id, assessmentId: 'd', category: 'assignment', level: 4, date: '2026-10-14' };
  expect(await call('policy.record', policy)).toMatchObject({ ok: true });
  expect(await call('grant.record', grant)).toMatchObject({ ok: true });
  expect(await call('autonomy.check', { assessmentId: 'd', level: 4 })).toMatchObject({ ok: true, data: { decision: 'allowed' } });
  expect(await call('grant.record', { ...grant, level: 0 })).toMatchObject({ ok: true });
  expect(await call('autonomy.check', { assessmentId: 'd', level: 4 })).toMatchObject({ ok: true, data: { decision: 'denied', reason: 'grant-revoked' } });
});
it('non-TTY CLI refuses both owner writes in one envelope without storing records', async () => {
  const host = await setup();
  for (const name of ['policy', 'grant']) {
    const stdout: string[] = [];
    const input = name === 'policy' ? ['--version', '1', '--course-id', synthetic.course.id, '--status', 'owner-attested', '--attestation', 'Synthetic', '--date', '2026-10-14', '--cap', '4']
      : ['--version', '1', '--course-id', synthetic.course.id, '--assessment-id', 'd', '--category', 'assignment', '--level', '4', '--date', '2026-10-14'];
    await parseProtocolCLI([name, 'record', ...input], { ...host, isTTY: false, stdout: s => stdout.push(s), stderr: () => {} });
    expect(stdout).toHaveLength(1); expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  }
  expect(await dispatch(host.registry, 'autonomy.check', { assessmentId: 'd', level: 3 }, host.context)).toMatchObject({ ok: true, data: { reason: 'policy-missing' } });
});
it('shared production file writer failure yields denied audit-unavailable', async () => {
  const host = await setup();
  const { ProtocolFiles } = await import('../../src/protocol/files.js');
  const { CourseworkError } = await import('../../src/protocol/errors.js');
  class BrokenFiles extends ProtocolFiles {
    override async append(): Promise<void> { throw new CourseworkError('INTERNAL', 'Synthetic writer outage'); }
  }
  const broken = createProductionProtocol({ store: host.store, files: new BrokenFiles(process.env.COURSEWORK_HOME) }); closes.push(broken.close);
  expect(await dispatch(broken.registry, 'autonomy.check', { assessmentId: 'd', level: 3 }, broken.context))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'audit-unavailable' } });
});
