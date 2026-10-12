import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { contracts, SourceEvidenceSchema, VerifiedCitationSchema } from '../../src/protocol/contracts.js';
import { createFakeContext, createFakeRegistry, examples } from '../../src/protocol/fakes.js';
import { dispatch } from '../../src/protocol/registry.js';

const digest = 'b'.repeat(64);
const recordedAt = '2026-02-01T12:00:00Z';
const receipts = {
  'policy.record': { recorded: 'policy', policyRef: digest, courseId: 'synthetic-course',
    status: 'owner-attested', cap: 4, recordedAt },
  'grant.record': { recorded: 'grant', grantRef: digest, courseId: 'synthetic-course',
    assessmentId: 'synthetic-assessment', category: 'assignment', level: 4, recordedAt },
} as const;

describe('issue A review regressions', () => {
  it.each(['sources.get', 'materials.list', 'courses.list'] as const)(
    '%s preserves source bytes, hash and original UTF-16 citation offsets', async name => {
      const text = '\n\r\n  🧪 Synthetic prefix.\nRead the synthetic guide.\r\n\t';
      const quote = 'Read the synthetic guide.';
      const sourceHash = createHash('sha256').update(text).digest('hex');
      const source = { ...examples['sources.get'].output, text, sourceHash };
      const citation = VerifiedCitationSchema.parse({ ...examples['revision.write'].output.citations[0],
        quote, offset: text.indexOf(quote), end: text.indexOf(quote) + quote.length, sourceHash });
      const context = createFakeContext();
      const output = name === 'sources.get' ? source : name === 'materials.list'
        ? { ...examples[name].output, items: [source], evidence: [source] }
        : { ...examples[name].output, evidence: [source] };
      context.repository.read = vi.fn(async () => output) as typeof context.repository.read;
      const result = await dispatch(createFakeRegistry(), name, examples[name].input, context);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected source evidence.');
      const data = contracts[name].output.parse(result.data);
      const returned = 'text' in data ? [data] : [ ...data.evidence,
        ...(name === 'materials.list' ? contracts[name].output.parse(data).items : []) ];
      for (const evidence of returned) {
        expect(Buffer.from(evidence.text)).toEqual(Buffer.from(text));
        expect(createHash('sha256').update(evidence.text).digest('hex')).toBe(citation.sourceHash);
        expect(evidence.text.slice(citation.offset, citation.end)).toBe(quote);
      }
    });

  it('keeps source text bounds and rejects whitespace-only evidence without transforming it', () => {
    for (const text of ['', '\n \t', 'x'.repeat(100001)]) {
      expect(SourceEvidenceSchema.safeParse({ ...examples['sources.get'].output, text }).success).toBe(false);
    }
  });

  it('validates current policy caps and exact grant bindings', () => {
    const policy = receipts['policy.record'];
    expect(contracts['policy.record'].output.safeParse({ ...policy, status: 'prohibited', cap: 1 }).success).toBe(true);
    for (const invalid of [{ ...policy, status: 'prohibited' }, { ...policy, cap: 1 },
      { ...policy, status: 'unknown' }, { ...policy, courseId: '' }]) {
      expect(contracts['policy.record'].output.safeParse(invalid).success).toBe(false);
    }
    const grant = receipts['grant.record'];
    for (const invalid of [{ ...grant, courseId: '' }, { ...grant, assessmentId: '' },
      { ...grant, category: 'unsupported' }, { ...grant, level: 2.5 }]) {
      expect(contracts['grant.record'].output.safeParse(invalid).success).toBe(false);
    }
  });

  it.each(['policy.record', 'grant.record'] as const)('%s returns a full strict receipt', async name => {
    const context = createFakeContext({ owner: true });
    const write = vi.fn(async () => receipts[name]);
    context.services.write = write as typeof context.services.write;
    expect(await dispatch(createFakeRegistry(), name, examples[name].input, context))
      .toMatchObject({ ok: true, data: receipts[name] });
    expect(write).toHaveBeenCalledOnce();
    for (const key of Object.keys(receipts[name])) {
      const incomplete: Record<string, unknown> = { ...receipts[name] };
      delete incomplete[key];
      expect(contracts[name].output.safeParse(incomplete).success, key).toBe(false);
    }
    for (const invalid of [{ ...receipts[name], recordedAt: 'yesterday' },
      { ...receipts[name], [name === 'policy.record' ? 'policyRef' : 'grantRef']: 'bad' },
      { ...receipts[name], [name === 'policy.record' ? 'cap' : 'level']: 5 },
      { ...receipts[name], secret: 'unsafe' }]) {
      expect(contracts[name].output.safeParse(invalid).success).toBe(false);
    }
  });

  it.each([['quiz.policy', 'policy.record'], ['quiz.grant', 'grant.record']] as const)(
    '%s retains its Q1 receipt through the canonical recording service', async (alias, canonical) => {
      const context = createFakeContext({ owner: true });
      const write = vi.fn(async () => receipts[canonical]);
      context.services.write = write as typeof context.services.write;
      expect(await dispatch(createFakeRegistry(), alias, examples[alias].input, context))
        .toMatchObject({ ok: true, data: examples[alias].output });
      expect(write).toHaveBeenCalledExactlyOnceWith(canonical, examples[alias].input, context);
      expect(contracts[alias].output.safeParse(receipts[canonical]).success).toBe(false);
      context.services.write = vi.fn(async () => ({ recorded: receipts[canonical].recorded })) as typeof context.services.write;
      expect(await dispatch(createFakeRegistry(), alias, examples[alias].input, context))
        .toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    });
});
