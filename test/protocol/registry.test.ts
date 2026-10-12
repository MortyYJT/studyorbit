import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contracts, envelopeSchema, type CommandInput, type CommandOutput } from '../../src/protocol/contracts.js';
import { Registry, dispatch, adaptLegacyHandler, type Handler } from '../../src/protocol/registry.js';
import { createFakeContext, createFakeRegistry, examples, FakeConfirmations } from '../../src/protocol/fakes.js';
import { ok, fail } from '../../src/protocol/envelope.js';
import { CourseworkError, retryable } from '../../src/protocol/errors.js';

const names = ['courses.list', 'assessments.list', 'tasks.list', 'sources.get', 'materials.list', 'changes', 'runs.list',
  'revision.list', 'practice.list', 'proposals.get', 'breakdown.write', 'revision.write', 'practice.write', 'quiz.propose',
  'quiz.read', 'quiz.review', 'quiz.prerequisites', 'policy.record', 'grant.record', 'audit.list', 'quiz.fill', 'quiz.submit',
  'quiz.policy', 'quiz.grant'];

describe('issue A contracts for M3', () => {
  it('exports every command with strict schema-valid synthetic examples and inferred consumer types', () => {
    expect(Object.keys(contracts).sort()).toEqual(names.sort());
    for (const name of Object.keys(contracts) as (keyof typeof contracts)[]) {
      expect(contracts[name].input.safeParse(examples[name].input).success, name).toBe(true);
      expect(contracts[name].output.safeParse(examples[name].output).success, name).toBe(true);
      expect(contracts[name].input.safeParse({ ...examples[name].input, owner: true }).success, name).toBe(false);
      expect(contracts[name].output.safeParse({ ...examples[name].output, secret: 'unsafe' }).success, name).toBe(false);
    }
    const request: CommandInput<'courses.list'> = { limit: 10 };
    const response: CommandOutput<'courses.list'> = examples['courses.list'].output;
    expect(response.items.length).toBeGreaterThan(0);
    expect(contracts['courses.list'].input.parse(request).limit).toBe(10);
  });
  it('bounds limits and preserves opaque new cursors versus exclusive numeric changes', () => {
    for (const name of names.filter(n => n.endsWith('.list')) as (keyof typeof contracts)[]) {
      for (const limit of [0, -1, 1.2, 501, Number.MAX_SAFE_INTEGER + 1]) {
        expect(contracts[name].input.safeParse({ ...examples[name].input, limit }).success).toBe(false);
      }
      expect(contracts[name].input.safeParse({ ...examples[name].input, cursor: 1 }).success).toBe(false);
    }
    expect(contracts.changes.input.parse({ since: 0 })).toEqual({ since: 0, limit: 100 });
    expect(contracts.changes.input.safeParse({ since: 'opaque' }).success).toBe(false);
    expect(contracts.changes.input.safeParse({ since: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });
  it('requires claim evidence, Task-compatible cited steps and the Q1 answer shape', () => {
    const note = structuredClone(examples['revision.write'].input);
    note.claims[0]!.citations = [];
    expect(contracts['revision.write'].input.safeParse(note).success).toBe(false);
    const practice = structuredClone(examples['practice.write'].input);
    practice.questions[0]!.explanation[0]!.citations = [];
    expect(contracts['practice.write'].input.safeParse(practice).success).toBe(false);
    const breakdown = structuredClone(examples['breakdown.write'].input);
    breakdown.task.steps[0]!.citations = [];
    expect(contracts['breakdown.write'].input.safeParse(breakdown).success).toBe(false);
    const proposal = structuredClone(examples['quiz.propose'].input);
    proposal.answers[0]!.statements = [];
    expect(contracts['quiz.propose'].input.safeParse(proposal).success).toBe(false);
    expect(contracts['quiz.submit'].input.safeParse({ ...examples['quiz.submit'].input, confirmed: true }).success).toBe(false);
  });
  it('rejects nested extra fields and bounds Task inputs without changing M1', () => {
    const breakdown = structuredClone(examples['breakdown.write'].input);
    breakdown.task.id = 'x'.repeat(257);
    expect(contracts['breakdown.write'].input.safeParse(breakdown).success).toBe(false);
    expect(contracts.changes.output.safeParse({ changes: [{ seq: 1, kind: 'created', entity: 'course',
      entityId: 'synthetic', after: {}, at: '2026-01-01T00:00:00Z', secret: 'raw' }], nextCursor: 1 }).success).toBe(false);
  });
  it('keeps Q1 aliases and minimum levels', () => {
    const registry = createFakeRegistry();
    expect(registry.get('quiz.policy')!.handler).toBe(registry.get('policy.record')!.handler);
    expect(registry.get('quiz.grant')!.handler).toBe(registry.get('grant.record')!.handler);
    for (const [name, level] of [['courses.list', 0], ['breakdown.write', 1], ['revision.write', 1], ['practice.write', 1],
      ['quiz.propose', 2], ['quiz.fill', 3], ['quiz.submit', 4]] as const) expect(registry.get(name)!.level).toBe(level);
  });
});

describe('transport-independent dispatcher', () => {
  function setup(handler: Handler = vi.fn(async () => ({ value: 'safe' }))) {
    const registry = new Registry();
    registry.register<z.ZodType, z.ZodType>({ name: 'synthetic', input: z.strictObject({}), output: z.strictObject({ value: z.string() }), handler, level: 0 });
    const context = createFakeContext();
    return { registry, context, handler };
  }
  it('rejects duplicates and unknown commands before execution, with safe failure audit', async () => {
    const { registry, context, handler } = setup();
    expect(() => registry.register(registry.get('synthetic')!)).toThrow();
    const result = await dispatch(registry, 'unknown', {}, context);
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(handler).not.toHaveBeenCalled();
    expect(context.events).toContainEqual(expect.objectContaining({ command: 'unknown', phase: 'denial', code: 'NOT_FOUND' }));
  });
  it('withholds unknown command prose from envelopes and both metadata journals', async () => {
    const { registry, context } = setup();
    for (const name of ['classmate.alice', 'password=raw']) {
      const result = await dispatch(registry, name, {}, context);
      expect(result).toMatchObject({ command: 'unknown', ok: false, error: { code: 'NOT_FOUND' } });
      expect(JSON.stringify([result, context.events, context.runEvents])).not.toContain(name);
    }
  });
  it('checks auth and privacy, validates defaults and executes once', async () => {
    const { registry, context, handler } = setup();
    const authorize = vi.spyOn(context.authorization, 'check');
    const privacy = vi.spyOn(context.privacy, 'protect');
    const result = await dispatch(registry, 'synthetic', {}, context);
    expect(result).toMatchObject({ ok: true, data: { value: 'safe' }, protocol: 'coursework.agent/v1' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(privacy).toHaveBeenCalledTimes(1);
    expect(context.events.every(e => e.runId === result.meta.runId)).toBe(true);
  });
  it('denies malformed inputs and authorization before handler invocation', async () => {
    const { registry, context, handler } = setup();
    expect(await dispatch(registry, 'synthetic', { owner: true }, context)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    context.authorization.check = async () => { throw new CourseworkError('INVALID_INPUT', 'authorization: secret'); };
    const result = await dispatch(registry, 'synthetic', {}, context);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(handler).not.toHaveBeenCalled();
  });
  it('owner-only commands cannot acquire host authority from request data', async () => {
    const context = createFakeContext();
    const registry = createFakeRegistry();
    expect(await dispatch(registry, 'policy.record', examples['policy.record'].input, context)).toMatchObject({ ok: false });
    context.owner = { assertOwner: async () => {} };
    expect(await dispatch(registry, 'policy.record', examples['policy.record'].input, context)).toMatchObject({ ok: true });
  });
  it('withholds invalid output, unsafe exceptions and oversized multibyte output', async () => {
    for (const handler of [async () => ({ value: 1 }), async () => ({ value: 'safe', secret: 'raw' }),
      async () => { throw new Error('password=raw'); }]) {
      const { registry, context } = setup(handler as never);
      const result = await dispatch(registry, 'synthetic', {}, context);
      expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL', retryable: false } });
      expect(JSON.stringify(result)).not.toContain('raw');
    }
    const { registry, context } = setup(vi.fn(async () => ({ value: '字 '.repeat(30000) })));
    const result = await dispatch(registry, 'synthetic', {}, context);
    expect(result).toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65536);
  });
  it('keeps the final metadata inside the exact byte bound', async () => {
    const baseline = Buffer.byteLength(JSON.stringify(ok('synthetic', { value: '' })));
    const length = 65536 - baseline;
    const { registry, context } = setup(async () => ({ value: 'x '.repeat(Math.floor(length / 2)) + (length % 2 ? 'x' : '') }));
    const result = await dispatch(registry, 'synthetic', {}, context);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65536);
  });
  it('invokes evidence on writes and preserves audit failures without unsafe error text', async () => {
    const context = createFakeContext();
    const evidence = vi.spyOn(context.evidence, 'check').mockRejectedValue(new CourseworkError('CITATION_MISMATCH', 'raw answer'));
    const result = await dispatch(createFakeRegistry(), 'revision.write', examples['revision.write'].input, context);
    expect(result).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
    expect(evidence).toHaveBeenCalledOnce();
    expect(JSON.stringify(context.events)).not.toContain('raw answer');
    expect(context.events.at(-1)).toMatchObject({ phase: 'denial', code: 'CITATION_MISMATCH' });
  });
  it('validates again after privacy and fails closed when audit or privacy is unavailable', async () => {
    const { registry, context, handler } = setup();
    context.audit.record = async () => { throw new Error('private path'); };
    expect(await dispatch(registry, 'synthetic', {}, context)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(handler).not.toHaveBeenCalled();
    const other = setup();
    other.context.privacy.protect = async () => ({ value: 1 });
    expect(await dispatch(other.registry, 'synthetic', {}, other.context)).toMatchObject({ ok: false });
  });
  it('adapts legacy success and every failure code without double wrapping or unsafe messages', async () => {
    const legacy = vi.fn(async () => ok('old', { value: 'safe' }));
    const { registry, context } = setup(adaptLegacyHandler(legacy));
    expect(await dispatch(registry, 'synthetic', {}, context)).toMatchObject({ ok: true, data: { value: 'safe' } });
    expect(legacy).toHaveBeenCalledTimes(1);
    for (const code of Object.keys(retryable) as (keyof typeof retryable)[]) {
      const other = setup(adaptLegacyHandler(async () => fail('old', code, 'private secret')));
      expect(await dispatch(other.registry, 'synthetic', {}, other.context)).toMatchObject({ ok: false, error: { code, retryable: retryable[code] } });
    }
  });
});

describe('fake contract consumer', () => {
  it('runs every command on schema-valid data without browser, filesystem or production ingestion', async () => {
    const context = createFakeContext({ owner: true, actions: true });
    const registry = createFakeRegistry();
    for (const name of Object.keys(contracts) as (keyof typeof contracts)[]) {
      const result = await dispatch(registry, name, examples[name].input, context);
      expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
      if (result.ok) expect(contracts[name].output.safeParse(result.data).success).toBe(true);
      expect(envelopeSchema(name).safeParse(result).success, name).toBe(true);
    }
    expect(context.actionCalls).toEqual(['quiz.fill', 'quiz.submit']);
  });
  it('returns an explicit unavailable action outcome when no adapter exists', async () => {
    const context = createFakeContext();
    const result = await dispatch(createFakeRegistry(), 'quiz.submit', examples['quiz.submit'].input, context);
    expect(result).toMatchObject({ ok: true, data: { status: 'unavailable', reason: 'SOURCE_UNAVAILABLE' } });
    expect(context.actionCalls).toEqual([]);
  });
});

describe('server confirmation contract fake', () => {
  it('binds exact filled target, consumes once, expires, and requires host owner on issuance', async () => {
    let now = 0;
    const service = new FakeConfirmations(() => now);
    const target = examples['quiz.submit'].output.target;
    const owner = { assertOwner: vi.fn(async () => {}) };
    const confirmation = await service.issue(target, owner);
    expect(owner.assertOwner).toHaveBeenCalledWith('quiz.submit');
    for (const changed of [{ ...target, filledRevision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { ...target, assessmentId: 'other' }, { ...target, policyRef: 'b'.repeat(64) },
      { ...target, page: { ...target.page, attemptId: '23' } }]) {
      await expect(service.consume(confirmation.token, changed)).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    await service.consume(confirmation.token, target);
    await expect(service.consume(confirmation.token, target)).rejects.toMatchObject({ code: 'CONFLICT' });
    const expired = await service.issue(target, owner);
    now = 60000;
    await expect(service.consume(expired.token, target)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
