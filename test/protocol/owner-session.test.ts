import { expect, it } from 'vitest';
import * as session from '../../src/protocol/owner-session.js';
import * as host from '../../src/protocol/http-host.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { Registry, dispatch } from '../../src/protocol/registry.js';
import { z } from 'zod';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
it('browser opening failure prints the fragment URL without reflecting opener errors', async () => {
  const messages: string[] = []; let attempted = '';
  await host.openOwnerBrowser('http://127.0.0.1:1234', session.createOwnerSession(), async url => { attempted = url; throw new Error('private error'); }, value => messages.push(value));
  expect(messages).toEqual([attempted]);
});
it('autonomy and confirmation commands refuse a TTY; other owner commands accept it', async () => {
  const registry = new Registry(); let writes = 0;
  for (const name of ['policy.record', 'grant.record', 'confirmation.resolve', 'planning.settings.record']) registry.register({ name, level: 0, input: z.strictObject({}), output: z.strictObject({}), handler: () => { writes++; return {}; } });
  for (const name of ['policy.record', 'grant.record', 'confirmation.resolve', 'planning.settings.record']) {
    const out: string[] = [];
    await parseProtocolCLI(name.split('.'), { registry, context: createFakeContext({ owner: true }), isTTY: true, stdout: s => out.push(s), stderr: () => {} });
    expect(JSON.parse(out[0]!).ok).toBe(name === 'planning.settings.record');
    if (name !== 'planning.settings.record') expect(JSON.parse(out[0]!).error.message).toContain('coursework ui');
  }
  expect(writes).toBe(1);
});
it('agent tools omit owner, sync and audit commands and cannot regain owner authority', async () => {
  const registry = new Registry(); let ownerWrites = 0;
  for (const name of ['autonomy.check', 'browser.submit', 'sync.run', 'audit.record', 'planning.settings.record', 'confirmation.resolve']) registry.register({ name, level: 0, input: z.strictObject({}), output: z.strictObject({}), handler: (_input, context) => { if (context.owner) ownerWrites++; return {}; } });
  const agent = registry.agentTools(createFakeContext({ owner: true }));
  expect(agent.registry.list().map(entry => entry.name)).toEqual(['autonomy.check', 'browser.submit']);
  expect(agent.context.owner).toBeUndefined();
  expect((await dispatch(agent.registry, 'planning.settings.record', {}, agent.context)).ok).toBe(false);
  expect((await dispatch(agent.registry, 'browser.submit', {}, agent.context)).ok).toBe(true);
  expect(ownerWrites).toBe(0);
});

it('opens the system browser through an absolute opener path, never a PATH lookup', async () => {
  const { systemBrowserCommand } = await import('../../src/protocol/http-host.js');
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const { command } = systemBrowserCommand(platform);
    expect(command === '/usr/bin/open' || command === '/usr/bin/xdg-open' || command === 'C:\\Windows\\System32\\rundll32.exe').toBe(true);
  }
});
