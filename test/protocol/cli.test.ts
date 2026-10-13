import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseProtocolCLI, MAX_INPUT_BYTES } from '../../src/protocol/cli.js';
import { Registry, createRegistry } from '../../src/protocol/registry.js';
import { createFakeContext, examples, FakeServices } from '../../src/protocol/fakes.js';
import { contracts, type CommandName } from '../../src/protocol/contracts.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function file(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'protocol-cli-')); directories.push(directory);
  const path = join(directory, 'input.json'); await writeFile(path, JSON.stringify(value)); return path;
}
function fixture(registry = createRegistry(), isTTY = true) {
  const context = createFakeContext({ owner: true });
  const stdout = vi.fn(); const stderr = vi.fn();
  return { registry, context, stdout, stderr, isTTY };
}
async function invoke(args: string[], options = fixture()) {
  await parseProtocolCLI(args, options);
  expect(options.stdout).toHaveBeenCalledOnce();
  return { response: JSON.parse(options.stdout.mock.calls[0]![0]!), options };
}
it('generates nested discovery/help/flags from injected contracts', async () => {
  const registry = new Registry(); const handler = vi.fn((_input: { count: number; active: boolean; label?: string }) => ({ accepted: true }));
  registry.register({ name: 'synthetic.inspect', input: z.strictObject({ count: z.number().int().min(1), active: z.boolean(), label: z.string().optional() }), output: z.strictObject({ accepted: z.boolean() }), level: 0, handler });
  const options = fixture(registry);
  const { response } = await invoke(['synthetic', 'inspect', '--count', '3', '--active', 'false', '--json'], options);
  expect(response).toMatchObject({ ok: true, command: 'synthetic.inspect', data: { accepted: true } });
  expect(handler).toHaveBeenCalledOnce(); expect(handler.mock.calls[0]?.[0]).toEqual({ count: 3, active: false });
  const help = await invoke(['synthetic', 'inspect', '--help'], fixture(registry));
  expect(help.response.data.usage).toContain('--count'); expect(help.response.data.usage).toContain('--active');
  expect(handler).toHaveBeenCalledOnce();
});
it.each(['3garbage', '0x10', '', 'Infinity', '1e309', '1.5'])('strict numeric parsing/refinements reject %j without handler', async value => {
  const options = fixture(); const read = vi.spyOn(options.context.repository, 'read');
  const { response } = await invoke(['courses', 'list', '--limit', value], options);
  expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(read).not.toHaveBeenCalled();
});
it.each(['courses.list', 'private-sentinel', 'courses list private-sentinel', 'courses list --private-sentinel', 'courses list --limit', 'courses list --limit 1 --limit 2', 'courses bogus --help', 'courses list private-sentinel --help'])('rejects unknown/invalid syntax %s with safe diagnostics', async command => {
  const { response, options } = await invoke(command.split(' '));
  expect(response.ok).toBe(false); expect(response.error.code).toBe('INVALID_INPUT');
  expect(options.stderr).toHaveBeenCalled();
  expect(JSON.stringify([response, options.stderr.mock.calls])).not.toContain('private-sentinel');
});
it('passes coerced filter flags and defaults through dispatcher once', async () => {
  const options = fixture(); const read = vi.spyOn(options.context.repository, 'read');
  const { response } = await invoke(['materials', 'list', '--course-id', 'synthetic-course', '--page', '2'], options);
  expect(response.ok).toBe(true); expect(read).toHaveBeenCalledWith('materials.list', { courseId: 'synthetic-course', page: 2, limit: 100 });
});
it.each(['policy.record', 'grant.record'] as const)('non-TTY refuses owner entry %s even with injected owner capability', async name => {
  const options = fixture(createRegistry(), false); const owner = vi.spyOn(options.context.owner!, 'assertOwner');
  const { response } = await invoke([...name.split('.'), '--input', await file(examples[name].input)], options);
  expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(owner).not.toHaveBeenCalled();
  expect((options.context.services as FakeServices).writes).toHaveLength(0);
});
it('rejects malformed, oversized, missing and mixed file input without executing', async () => {
  const path = await file({}); const malformed = fixture();
  await writeFile(path, '{private-sentinel');
  expect((await invoke(['revision', 'write', '--input', path], malformed)).response.error.code).toBe('INVALID_INPUT');
  await truncate(path, MAX_INPUT_BYTES + 1);
  expect((await invoke(['revision', 'write', '--input', path])).response.error.code).toBe('LIMIT_EXCEEDED');
  expect((await invoke(['revision', 'write', '--input', `${path}-missing`])).response.error.code).toBe('INVALID_INPUT');
  await writeFile(path, JSON.stringify(examples['courses.list'].input));
  expect((await invoke(['courses', 'list', '--input', path, '--limit', '2'])).response.error.code).toBe('INVALID_INPUT');
  expect((malformed.context.services as FakeServices).writes).toHaveLength(0);
});
it('stdout sink failures never print a second envelope', async () => {
  const options = fixture(); options.stdout.mockImplementation(() => { throw Error('sink failure'); });
  await expect(parseProtocolCLI(['courses', 'list'], options)).rejects.toThrow('sink failure');
  expect(options.stdout).toHaveBeenCalledOnce();
});
it('runtime output validation and bounds remain dispatcher-owned', async () => {
  const registry = new Registry(); const handler = vi.fn(() => '界'.repeat(30000));
  registry.register({ name: 'synthetic.large', input: z.strictObject({}), output: z.string(), level: 0, handler });
  const { response } = await invoke(['synthetic', 'large'], fixture(registry));
  expect(response).toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } }); expect(handler).toHaveBeenCalledOnce();
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(65536);
});
it('file JSON types remain strict rather than coerced', async () => {
  const { response } = await invoke(['courses', 'list', '--input', await file({ limit: '2' })]);
  expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(contracts['courses.list'].input.safeParse({ limit: '2' }).success).toBe(false);
});
it('strict booleans reject truthy text and nested JSON flags retain schema refinements', async () => {
  const registry = new Registry(); const handler = vi.fn((_input: unknown) => ({ accepted: true }));
  registry.register({ name: 'synthetic.inspect', input: z.strictObject({ active: z.boolean(), nested: z.strictObject({ count: z.number().int().positive() }) }),
    output: z.strictObject({ accepted: z.boolean() }), level: 0, handler });
  expect((await invoke(['synthetic', 'inspect', '--active', 'yes', '--nested', '{"count":1}'], fixture(registry))).response.ok).toBe(false);
  expect((await invoke(['synthetic', 'inspect', '--active', 'false', '--nested', '{"count":"1"}'], fixture(registry))).response.ok).toBe(false);
  expect((await invoke(['synthetic', 'inspect', '--active', 'false', '--nested', '{"count":1}'], fixture(registry))).response.ok).toBe(true);
  expect(handler).toHaveBeenCalledOnce();
});
it('file input rejects unknown fields and special files safely', async () => {
  const options = fixture(); const read = vi.spyOn(options.context.repository, 'read');
  expect((await invoke(['courses', 'list', '--input', await file({ limit: 1, owner: true })], options)).response.error.code).toBe('INVALID_INPUT');
  expect(read).not.toHaveBeenCalled();
  expect((await invoke(['courses', 'list', '--input', '/dev/zero'])).response.error.code).toBe('INVALID_INPUT');
});
it('generates discriminated-union contract flags without choosing a business variant', async () => {
  const registry = new Registry(); const handler = vi.fn((_input: unknown) => ({ accepted: true }));
  registry.register({ name: 'synthetic.record', input: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('allowed'), cap: z.number().int().min(2).max(4), quote: z.string().min(1) }),
    z.strictObject({ kind: z.literal('prohibited'), cap: z.literal(1), quote: z.string().min(1) }),
  ]), output: z.strictObject({ accepted: z.boolean() }), handler, level: 0 });
  const { response } = await invoke(['synthetic', 'record', '--kind', 'prohibited', '--cap', '1', '--quote', 'Synthetic rule.'], fixture(registry));
  expect(response.ok).toBe(true); expect(handler).toHaveBeenCalledOnce();
  expect(handler.mock.calls[0]![0]).toEqual({ kind: 'prohibited', cap: 1, quote: 'Synthetic rule.' });
  expect((await invoke(['synthetic', 'record', '--kind', 'allowed', '--cap', '1', '--quote', 'Synthetic rule.'], fixture(registry))).response.ok).toBe(false);
});
