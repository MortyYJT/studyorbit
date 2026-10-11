import { expect, it } from 'vitest';
import { createRedactor } from '../../src/sync/redaction.js';
import { syncEd } from '../../src/sync/ed-adapter.js';
import { selected } from '../quiz/synthetic.js';
import { fixture, reader, time } from './synthetic.js';
it.each(['phone_number', 'phoneNumber', 'mobile', 'telephone'])('4.3 harvests explicit contact field %s before publishing', async field => {
  const bodies = fixture();
  bodies['/api/courses/7/threads?limit=30&sort=new'] = { threads: [{ id: 41, title: 'Synthetic contact', content: '61 (400) 000-000', author: { [field]: 61400000000 } }] };
  const result = await syncEd({ selection: selected, transport: reader(bodies), fetchedAt: time });
  const source = result.sources.find(s => s.externalId === 'thread:41')!;
  expect(source.text).toBe('title: Synthetic contact\ncontent: [redacted]');
  expect(result.citations.find(c => c.sourceItemId === source.id)?.quote).toBe(source.text);
});
it('4.3 shares canonical whitespace across names, staff exceptions and owner rules', () => {
  const redactor = createRedactor({ author: { name: 'Synthetic  Staff', email: 'staff@example.invalid' }, people: [{ name: 'Synthetic  Person-Z' }] },
    { staffNames: ['Ｓynthetic Staff'], ownerRules: ['Ｐrivate  tag'] });
  expect(redactor.text('Synthetic\nStaff staff@example.invalid Synthetic\nPerson-Z Private\ntag')).toBe('Synthetic\nStaff [redacted] [redacted] [redacted]');
});
it('4.3 redacts eleven-digit numbers even without a harvested phone field', () => {
  expect(createRedactor([]).text('Contact 61400000000')).toBe('Contact [redacted]');
});
it.each(['Synthetic  Person-Z', 'Synthetic\nPerson-Z', 'Synthetic\r\n\tPerson-Z'])('4.3 redacts name whitespace variants in sources and citations: %j', async variant => {
  const bodies = fixture();
  bodies['/api/courses/7/threads?limit=30&sort=new'] = { threads: [{ id: 41, title: variant, content: variant, author: { name: 'Synthetic Person-Z' } }] };
  const result = await syncEd({ selection: selected, transport: reader(bodies), fetchedAt: time });
  const source = result.sources.find(s => s.externalId === 'thread:41')!;
  expect(source).toBeDefined();
  expect(source.title).toBe('[redacted]');
  expect(source.text).not.toContain('Person-Z');
  expect(result.citations.find(c => c.sourceItemId === source.id)?.quote).toBe(source.text);
});
it.each(['61400000000', '+61 400 000 000', '61 (400) 000-000', '６１４００００００００'])('4.3 redacts known numeric phones and their text representations: %j', async phone => {
  const bodies = fixture();
  bodies['/api/courses/7/threads?limit=30&sort=new'] = { threads: [{ id: 41, title: phone, content: phone, author: { name: 'Synthetic Staff', phone: 61400000000 } }] };
  const result = await syncEd({ selection: selected, transport: reader(bodies), fetchedAt: time, rules: { staffNames: ['Synthetic Staff'] } });
  const source = result.sources.find(s => s.externalId === 'thread:41')!;
  expect(source.title).toBe('[redacted]');
  expect(source.text).toBe('title: [redacted]\ncontent: [redacted]');
  expect(result.citations.find(c => c.sourceItemId === source.id)?.quote).toBe(source.text);
});
it('4.3 canonicalizes owner rules before matching text and decoded URLs', async () => {
  const rules = { ownerRules: ['Ｐrivate-tag'] };
  expect(createRedactor([], rules).text('https://edstem.org/%EF%BC%B0rivate-tag')).not.toContain('Private-tag');
  const bodies = fixture();
  bodies['/api/courses/7/threads?limit=30&sort=new'] = { threads: [{ id: 41, title: 'Private-tag', content: 'Ｐrivate-tag' }] };
  const result = await syncEd({ selection: selected, transport: reader(bodies), fetchedAt: time, rules });
  const source = result.sources.find(s => s.externalId === 'thread:41')!;
  expect(source.title).toBe('[redacted]');
  expect(result.citations.find(c => c.sourceItemId === source.id)?.quote).toBe('title: [redacted]\ncontent: [redacted]');
});
it.each([null, {}, ['61400000000'], true, 61400000000.5, 'call-private-sentinel'])('4.3 withholds the scope when a known phone cannot be validated: %j', async phone => {
  const bodies = fixture();
  bodies['/api/courses/7/resources'] = { resources: [{ id: 51, title: 'Synthetic resource', author: { phone } }] };
  await expect(syncEd({ selection: selected, transport: reader(bodies), fetchedAt: time })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', message: 'Normalized source withheld by privacy validation.' });
});
it('4.3 harvests nested names across the entire scope before text, title and encoded URL redaction', () => {
  const scope = [{ title: 'Synthetic Person-Z', url: 'https://edstem.org/Synthetic%20Person-Z' },
    { children: [{ authors: [{ display_name: 'Synthetic Person-Z' }], people: [{ name: '测试同学甲' }] }] }];
  const redactor = createRedactor(scope);
  expect(redactor.text('Synthetic Person-Z 测试同学甲')).not.toMatch(/Person-Z|同学甲/);
  expect(redactor.text(scope[0].url!)).not.toContain('Person-Z');
});
it('4.3 owner literals and staff names never exempt emails, student numbers, phones or secrets', () => {
  const redactor = createRedactor([{ author: { name: 'Synthetic Staff' } }], { ownerRules: ['private-tag'], staffNames: ['Synthetic Staff'] });
  const text = redactor.text('Synthetic Staff private-tag staff@example.invalid student number: 1234567 +61 400 000 000');
  expect(text).toContain('Synthetic Staff');
  expect(text).not.toMatch(/private-tag|example|1234567|400/);
  expect(() => redactor.text('Synthetic Staff api_key=synthetic-secret')).toThrowError();
});
it('4.3 is deterministic and hashes redacted semantic text, excluding fetch time and private names', async () => {
  const run = async (name: string) => {
    const bodies = fixture();
    bodies['/api/courses/7/threads?limit=30&sort=new'] = { threads: [{ id: 41, title: name, content: `Contact ${name}` }] };
    bodies['/api/courses/7/resources'] = { resources: [{ id: 51, title: 'Synthetic resource', nested: { people: [{ name }] } }] };
    return syncEd({ selection: selected, transport: reader(bodies), fetchedAt: time });
  };
  const a = await run('Synthetic Person-Z'); const b = await run('Synthetic Person-Y');
  const post = a.sources.find(s => s.externalId === 'thread:41')!;
  expect(JSON.stringify(a)).not.toContain('Synthetic Person-Z');
  expect(post.contentHash).toBe(b.sources.find(s => s.externalId === 'thread:41')!.contentHash);
  expect(JSON.stringify(await run('Synthetic Person-Z'))).toBe(JSON.stringify(a));
});
it('4.3 suppresses profiles and other students answers while retaining selected question text', async () => {
  const bodies = fixture(); bodies['/api/lessons/slides/21'] = { slide: { id: 21, author: { name: 'Synthetic Person-Z', email: 'z@example.invalid' },
    questions: [{ id: 31, type: 'text', prompt: 'Synthetic Person-Z sample', answers: [{ text: 'other-answer-sentinel' }] }] } };
  const result = await syncEd({ selection: selected, transport: reader(bodies), fetchedAt: time });
  expect(JSON.stringify(result)).not.toMatch(/Person-Z|example.invalid|other-answer-sentinel/);
  expect(result.sources.find(s => s.id === 'ed:7:11:21:31')?.text).toContain('[redacted]');
});
it('4.3 staff allow-list survives Q1 normalization without reharvesting suppressed profiles', async () => {
  const bodies = fixture(); bodies['/api/lessons/11'] = { lesson: { id: 11, slides: [{ id: 21 }], author: { name: 'Synthetic Staff' } } };
  bodies['/api/lessons/slides/21'] = { slide: { id: 21, questions: [{ id: 31, type: 'text', prompt: 'Synthetic Staff example staff@example.invalid' }] } };
  const result = await syncEd({ selection: selected, transport: reader(bodies), fetchedAt: time, rules: { staffNames: ['Synthetic Staff'] } });
  expect(result.sources.find(s => s.id === 'ed:7:11:21:31')?.text).toContain('Synthetic Staff');
  expect(JSON.stringify(result)).not.toContain('staff@example.invalid');
});
