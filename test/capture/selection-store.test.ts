import { it, expect } from 'vitest';
import { mkdtemp, readFile, stat, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelectionStore } from '../../src/capture/selection-store.js';
const selected = { version: 1 as const, courses: [{ source: 'canvas' as const, origin: 'https://canvas.lms.unimelb.edu.au', id: '42', term: { label: 'Course Term' } }] };
it('validates and atomically replaces private versioned selections including empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'selection-test-'));
  try {
    const store = new SelectionStore(dir); expect(await store.load()).toEqual({ status: 'absent' });
    await store.save(selected); expect(await store.load()).toEqual({ status: 'valid', selection: selected });
    const path = join(dir, 'capture-selection.json'); const inode = (await stat(path)).ino;
    await store.save({ version: 1, courses: [] });
    expect((await stat(path)).ino).not.toBe(inode); expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.load()).toEqual({ status: 'valid', selection: { version: 1, courses: [] } });
    expect(await readdir(dir)).toEqual(['capture-selection.json']);
    await expect(store.save({ ...selected, token: 'synthetic' } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(JSON.parse(await readFile(path, 'utf8')).courses).toEqual([]);
    for (const bad of ['{', '{"version":2,"courses":[]}', JSON.stringify({ ...selected, courses: [{ ...selected.courses[0], origin: 'https://other.invalid' }] }), JSON.stringify({ ...selected, courses: [selected.courses[0], selected.courses[0]] })]) {
      await writeFile(path, bad); expect(await store.load()).toEqual({ status: 'invalid' });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
