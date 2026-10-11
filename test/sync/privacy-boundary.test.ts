import { expect, it, vi } from 'vitest';
import { redactNormalizedSources } from '../../src/sync/privacy-boundary.js';
import { createRedactor } from '../../src/sync/redaction.js';
import { syncEd } from '../../src/sync/ed-adapter.js';
import { selected } from '../quiz/synthetic.js';
import { fixture, reader, time } from './synthetic.js';
const source = (platform: 'canvas' | 'ed') => ({ id: `${platform}:${'a'.repeat(64)}`, platform, externalId: 'thread:41',
  courseId: `${platform}:${'b'.repeat(64)}`, kind: 'post', title: 'Synthetic Person-Z',
  url: 'https://edstem.org/Synthetic%20Person-Z', text: 'Synthetic Person-Z z@example.invalid', contentHash: 'raw-hash', fetchedAt: time });
it.each(['canvas', 'ed'] as const)('4.4 protects %s normalized output and hashes redacted fields', provider => {
  const result = redactNormalizedSources(provider, [source(provider)], [{ people: [{ name: 'Synthetic Person-Z' }] }]);
  expect(JSON.stringify(result)).not.toMatch(/Person-Z|example.invalid|raw-hash/);
  expect(result[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
});
it.each([{ enabled: false }, { ownerRules: [42] }, { ownerRules: [''] }, { ownerRules: [{ pattern: '.*' }] }, { staffNames: ['<unsafe>'] }])('4.4 rejects malformed rules or bypass flags before network reads', async rules => {
  const transport = reader();
  await expect(syncEd({ selection: selected, transport, fetchedAt: time, rules })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  expect(transport.read).not.toHaveBeenCalled();
});
it.each(['<script>unsafe</script>', 'api_key=sentinel-secret', 'https://edstem.org/%ZZ', 'https://person:secret@edstem.org/a'])('4.4 withholds unsafe text without raw exception output', text => {
  try { createRedactor([]).text(text); throw new Error('accepted unsafe source'); }
  catch (error) { expect(error).toMatchObject({ code: 'SOURCE_UNAVAILABLE' }); expect(JSON.stringify(error)).not.toContain('sentinel-secret'); }
});
it('4.4 rejects extra payloads, provider mismatch and unsafe identity slots rather than raw fallback', () => {
  for (const bad of [{ ...source('ed'), profile: { secret: 'sentinel' } }, { ...source('ed'), id: 'Synthetic Person-Z' }, source('canvas')]) {
    expect(() => redactNormalizedSources('ed', [bad], [])).toThrowError();
  }
});
it('4.4 sanitizes transport and snapshot errors, keeps bounded content-free gaps', async () => {
  const transport: EdReader = { read: vi.fn(async () => { throw new Error('private-secret-sentinel'); }) };
  const result = await syncEd({ selection: selected, transport, fetchedAt: time });
  expect(JSON.stringify(result)).not.toContain('private-secret-sentinel');
  expect(result.gaps.length).toBeLessThanOrEqual(4);
  expect(result.gaps.every(g => /^[a-f0-9]{64}$/.test(g.scopeRef))).toBe(true);
});
it('4.4 unknown nested person fields or excessive depth withhold output safely', () => {
  expect(() => createRedactor([{ author: { name: 'Synthetic Person-Z', unusual_name: 'unknown-person' } }])).toThrowError();
  let deep: unknown = 'synthetic'; for (let i = 0; i < 40; i++) deep = { nested: deep };
  expect(() => createRedactor(deep)).toThrowError();
});
it('4.4 embedded encoded URLs cannot hide harvested names', () => {
  expect(createRedactor([{ author: 'Synthetic Person-Z' }]).text('url: https://edstem.org/Synthetic%20Person-Z')).not.toContain('Person-Z');
});
import type { EdReader } from '../../src/capture/ed-capture.js';
it('4.4 wraps invalid URLs after redaction in a content-free diagnostic', () => {
  try {
    redactNormalizedSources('ed', [{ ...source('ed'), url: 'https://person-z.example.invalid/private-sentinel' }], [{ author: 'person-z' }]);
    throw new Error('accepted unsafe URL');
  } catch (error) {
    expect(error).toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(JSON.stringify(error)).not.toContain('private-sentinel');
  }
});
