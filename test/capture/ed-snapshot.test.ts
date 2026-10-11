import { mkdtemp, readFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { writeEdSnapshot } from '../../src/capture/ed-snapshot.js';
it('writes collision-safe private snapshots with faithful XML and dates and safe metadata', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ed-synthetic-'));
  try {
    const body = { xml: '<document version="2.0">Synthetic &amp; text</document>', due_at: '2026-11-01T09:00:00+11:00', author: { name: 'Synthetic Classmate' }, headers: { 'x-token': 'synthetic-secret' }, authToken: 'synthetic-secret' };
    const paths = await Promise.all(Array.from({ length: 5 }, () => writeEdSnapshot('/api/lessons/slides/21', body, 200, home)));
    expect(new Set(paths).size).toBe(5);
    for (const path of paths) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
      for (const filename of ['response.json', 'meta.json']) expect((await stat(join(path, filename))).mode & 0o777).toBe(0o600);
      const content = await readFile(join(path, 'response.json'), 'utf8');
      expect(JSON.parse(content)).toEqual({ xml: body.xml, due_at: body.due_at, author: body.author });
      expect(content).not.toMatch(/synthetic-secret|x-token|authToken/);
      const metadata = JSON.parse(await readFile(join(path, 'meta.json'), 'utf8'));
      expect(metadata).toMatchObject({ source: 'ed', endpoint: '/api/lessons/slides/21', status: 200 });
      expect(JSON.stringify(metadata)).not.toMatch(/Synthetic Classmate|document|headers|token/i);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
it('stores only courses for user and allows already projected discovery array', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ed-user-synthetic-'));
  try {
    for (const body of [{ courses: [], user: { name: 'Synthetic Private' }, push_key: 'private', push_subscriptions: [], other: 'private' }, []]) {
      const path = await writeEdSnapshot('/api/user', body, 200, home);
      expect(JSON.parse(await readFile(join(path, 'response.json'), 'utf8'))).toEqual([]);
    }
    await expect(writeEdSnapshot('/api/user', { user: 'private' }, 200, home)).rejects.toThrow();
  } finally { await rm(home, { recursive: true, force: true }); }
});
it('refuses unsafe metadata/failed responses before writing and guards default local paths with gitignore', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ed-invalid-synthetic-'));
  try {
    await expect(writeEdSnapshot('/api/lessons/21?view=1', {}, 200, home)).rejects.toThrow();
    await expect(writeEdSnapshot('/api/user', [], 401, home)).rejects.toThrow();
    expect(await readdir(home)).toEqual([]);
    for (const path of ['.local/snapshots/edstem.org/synthetic/response.json', '.local/capture-selection.json', '.local/crawls/synthetic.json']) {
      expect(execFileSync('git', ['check-ignore', path], { encoding: 'utf8' }).trim()).toBe(path);
    }
    expect(relative(process.cwd(), home)).not.toContain('.local');
  } finally { await rm(home, { recursive: true, force: true }); }
});
