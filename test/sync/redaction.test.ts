import { expect, it } from 'vitest';
import { createRedactor } from '../../src/sync/redaction.js';
import { syncEd } from '../../src/sync/ed-adapter.js';
import { selected } from '../quiz/synthetic.js';
import { fixture, reader, time } from './synthetic.js';
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
