import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolTabRecords } from '../../src/browser/tools/tab-records.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('11.5 owner focus resolves only tool-created private references across hosts and removes closed tabs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tab-records-')); roots.push(root);
  const dir = join(root, 'tabs'); const id = randomUUID(); const writer = new ToolTabRecords(dir);
  await writer.save(id, 'synthetic-target'); expect(await new ToolTabRecords(dir).load(id)).toBe('synthetic-target');
  expect(statSync(join(dir, `${id}.json`)).mode & 0o777).toBe(0o600);
  await expect(new ToolTabRecords(dir).load(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await writer.remove(id); await expect(writer.load(id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('11.5 refuses symlink tab storage before writing a browser capability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tab-records-')); roots.push(root);
  const target = join(root, 'other'); mkdirSync(target); const link = join(root, 'tabs'); symlinkSync(target, link);
  await expect(new ToolTabRecords(link).save(randomUUID(), 'synthetic-target')).rejects.toBeDefined();
});
