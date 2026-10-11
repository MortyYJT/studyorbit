import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { writeCrawlSummary, summaryFilename, type CrawlSummary } from '../../src/capture/crawl.js';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
it('writes the exact summary fields in crawls with the UTC ISO filename and private permissions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'coursework-summary-')); roots.push(home); vi.stubEnv('COURSEWORK_HOME', home);
  const summary: CrawlSummary = { startedAt: '2026-10-11T10:08:17.000Z', durationMs: 1080, saved: 1, failed: 1, status: 'completed', failedUrls: ['https://canvas.lms.unimelb.edu.au/courses/91001/grades'] };
  await writeCrawlSummary(summary);
  const name = '2026-10-11T10-08-17Z.json';
  expect(summaryFilename(summary.startedAt)).toBe(name); expect(readdirSync(join(home, 'crawls'))).toEqual([name]);
  const path = join(home, 'crawls', name); expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(summary);
  expect(statSync(path).mode & 0o777).toBe(0o600); expect(readdirSync(home)).toEqual(['crawls']);
});
it('preserves both summaries for runs begun in the same second', async () => {
  const home = mkdtempSync(join(tmpdir(), 'coursework-summary-')); roots.push(home); vi.stubEnv('COURSEWORK_HOME', home);
  const summary: CrawlSummary = { startedAt: '2026-10-11T10:08:17.000Z', durationMs: 0, saved: 0, failed: 0, status: 'aborted', failedUrls: [] };
  await writeCrawlSummary(summary); await writeCrawlSummary({ ...summary, saved: 1 });
  const files = readdirSync(join(home, 'crawls')); expect(files).toHaveLength(2);
  expect(files.every(name => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/.test(name))).toBe(true);
  expect(files.map(name => JSON.parse(readFileSync(join(home, 'crawls', name), 'utf8')).saved).sort()).toEqual([0, 1]);
});
