import { describe, expect, it } from 'vitest';
import { agentContextBody, describeStatus, frameUrl, INSTALL_COMMAND, statusPollMs } from '../web/src/agent-frame.js';

// Pure parts of the Agent page that shows DeepTutor in a frame (decision #548). Synthetic values only.
describe('frameUrl', () => {
  it('keeps the page own host name and the assistant port, and opens a session when there is one', () => {
    expect(frameUrl('http://localhost:5185', 'localhost')).toBe('http://localhost:5185/chat');
    expect(frameUrl('http://localhost:5185', '127.0.0.1', 'unified_1_abc')).toBe('http://127.0.0.1:5185/chat/unified_1_abc');
  });
  it('refuses a session id that is not a plain token and an address that is not loopback http', () => {
    expect(frameUrl('http://localhost:5185', 'localhost', '../settings')).toBe('http://localhost:5185/chat');
    expect(frameUrl('http://localhost:5185', 'localhost', 'a?b=1')).toBe('http://localhost:5185/chat');
    expect(frameUrl('https://evil.example', 'localhost')).toBeNull();
    expect(frameUrl('http://evil.example:5185', 'localhost')).toBeNull();
    expect(frameUrl('javascript:alert(1)', 'localhost')).toBeNull();
    // The page host is used only when it is a loopback name itself.
    expect(frameUrl('http://localhost:5185', 'evil.example')).toBe('http://localhost:5185/chat');
  });
});

describe('agentContextBody', () => {
  const work = [
    { key: 'a', courseId: '900101', courseCode: 'SYNT10001', title: 'Draft', due: '2026-09-18', minutes: 60 },
    { key: 'b', courseId: '900102', courseCode: 'SYNT20002', title: 'Done already', due: '2026-09-19', minutes: 30, done: true },
    { key: 'c', courseId: '', courseCode: '', title: 'Personal', due: '2026-09-20', minutes: 45 },
  ];
  it('sends the selection, the focus course and the page planning data for the loaded courses', () => {
    const body = agentContextBody({ courseIds: ['900101', '900102'], focusCourseId: '900102', work, availability: [60, 60, 60, 60, 60, 0, 0], targets: { '900101': 'H1', '777': 'H1' } });
    expect(body.selectedCourseIds).toEqual(['900101', '900102']);
    expect(body.focusCourseId).toBe('900102');
    expect(body.planning.tasks.map(task => task.key)).toEqual(['a', 'c']);
    expect(body.planning.targets).toEqual({ '900101': 'H1' });
    expect(body.planning.availability).toEqual([60, 60, 60, 60, 60, 0, 0]);
  });
  it('has no focus when the course is not one of the loaded courses', () => {
    expect(agentContextBody({ courseIds: ['900101'], focusCourseId: '555', work: [], availability: [0, 0, 0, 0, 0, 0, 0], targets: {} }).focusCourseId).toBeNull();
    expect(agentContextBody({ courseIds: ['900101'], work: [], availability: [0, 0, 0, 0, 0, 0, 0], targets: {} }).focusCourseId).toBeNull();
  });
});

describe('describeStatus', () => {
  it('gives every state that is not running a title, what to do, and the exact command where one helps', () => {
    for (const language of ['zh', 'en'] as const) {
      const missing = describeStatus({ state: 'not-installed' }, language)!;
      expect(missing.command).toBe(INSTALL_COMMAND);
      expect(missing.command).toContain('deeptutor[server,web,memory,questions,notebook]==1.7.4');
      expect(missing.command).not.toContain('solve');
      expect(describeStatus({ state: 'failed', reason: 'DeepTutor API exited' }, language)).toMatchObject({ detail: 'DeepTutor API exited', command: 'npm run dev' });
      expect(describeStatus({ state: 'unsupported-provider' }, language)).toMatchObject({ settings: true });
      expect(describeStatus({ state: 'off' }, language)!.title.length).toBeGreaterThan(0);
      expect(describeStatus({ state: 'starting' }, language)).toMatchObject({ busy: true });
      expect(describeStatus({ state: 'running', url: 'http://localhost:5185' }, language)).toBeNull();
      expect(describeStatus({ state: 'external', url: 'http://localhost:5185' }, language)).toBeNull();
      expect(describeStatus(null, language)).toMatchObject({ busy: true });
    }
    expect(describeStatus({ state: 'not-installed' }, 'zh')!.title).not.toBe(describeStatus({ state: 'not-installed' }, 'en')!.title);
  });
});

describe('statusPollMs', () => {
  it('asks often while starting and seldom once the answer is settled', () => {
    expect(statusPollMs(null)).toBe(1000);
    expect(statusPollMs({ state: 'starting' })).toBe(1000);
    expect(statusPollMs({ state: 'running', url: 'x' })).toBe(5000);
    expect(statusPollMs({ state: 'failed', reason: 'x' })).toBe(5000);
  });
});
