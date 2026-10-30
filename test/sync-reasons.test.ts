import { describe, expect, it } from 'vitest';
import { collectorFailureReason, sanitiseDetail, translateReason } from '../shared/sync-reasons.ts';

// Collector failure reasons (sync-incomplete fix 1): the stderr of a failed collector becomes one clear, sanitised
// reason. Synthetic stderr only, shaped like the real collectors' messages.
const HINT = '如提示 JavaScript from Apple Events，请在 Edge 开发者菜单允许后重试。';
const canvas = { source: 'canvas', label: 'Canvas', browser: 'edge-applescript' };

describe('collectorFailureReason', () => {
  it('names a browser without a window', () => {
    const error = `Canvas 后台采集失败：Command failed: /usr/bin/osascript -e on run argv\n execution error: Microsoft Edge got an error: EDGE_WINDOW_MISSING (-2700)。${HINT}`;
    expect(collectorFailureReason({ ...canvas, code: 1, error })).toBe('Edge 没有打开窗口，请打开一个 Edge 窗口后重试');
    expect(collectorFailureReason({ ...canvas, browser: 'chrome-applescript', code: 1, error: 'Google Chrome got an error: CHROME_WINDOW_MISSING' }))
      .toBe('Chrome 没有打开窗口，请打开一个 Chrome 窗口后重试');
  });

  it('names a browser that is not running, and Apple Events JavaScript turned off (not the appended hint)', () => {
    expect(collectorFailureReason({ ...canvas, code: 1, error: `Canvas 后台采集失败：请先打开 Microsoft Edge 并登录。${HINT}` }))
      .toBe('Edge 没有打开，请打开 Edge 并登录 Canvas 后重试');
    expect(collectorFailureReason({ ...canvas, code: 1, error: `Canvas 后台采集失败：Executing JavaScript through AppleScript is turned off. To turn it on, go to View > Developer > Allow JavaScript from Apple Events.。${HINT}` }))
      .toBe('Edge 不允许来自 Apple 事件的 JavaScript，请在 Edge 的开发者菜单里允许后重试');
    // The hint alone is not a cause.
    expect(collectorFailureReason({ ...canvas, code: 1, error: `Canvas 后台采集失败：Canvas 下一页链接不属于当前接口。${HINT}` }))
      .toBe('Canvas 采集失败：Canvas 下一页链接不属于当前接口');
  });

  it('turns Canvas HTTP 401, 403 and a sign-in redirect into an expired sign-in', () => {
    for (const message of ['Canvas HTTP 401', 'Canvas HTTP 403', 'Canvas 登录可能已失效或页面跳转']) {
      expect(collectorFailureReason({ ...canvas, code: 1, error: `Canvas 后台采集失败：${message}。${HINT}` })).toBe('Canvas 登录已失效，请在 Edge 里重新登录 Canvas');
    }
    expect(collectorFailureReason({ ...canvas, code: 1, error: 'Canvas HTTP 404' })).toBe('Canvas 采集失败：Canvas HTTP 404');
  });

  it('reports timeouts, Ed problems and an empty stderr', () => {
    expect(collectorFailureReason({ source: 'handbook', label: 'Handbook', code: null, error: '', timedOut: true })).toBe('Handbook 采集超时，请检查网络和浏览器后重试');
    expect(collectorFailureReason({ ...canvas, code: 1, error: 'Canvas 后台采集失败：Canvas 页面加载超时。' })).toBe('Canvas 采集超时，请检查网络和浏览器后重试');
    expect(collectorFailureReason({ source: 'ed', label: 'Ed', code: 1, error: 'ED_SIGNED_OUT' })).toBe('Ed 未登录，请在终端运行 edstem auth login 后重试');
    expect(collectorFailureReason({ source: 'ed', label: 'Ed', code: 1, error: 'Ed 采集失败：spawn edstem ENOENT' })).toBe('找不到 edstem 命令，请先安装 edstem-cli');
    expect(collectorFailureReason({ source: 'ed', label: 'Ed', code: 1, error: '' })).toBe('Ed 采集失败（退出码 1）');
    expect(collectorFailureReason({ source: 'ed', label: 'Ed', code: null, error: '' })).toBe('Ed 采集失败（退出码 无）');
  });

  it('never keeps paths, URL queries, cookies or tokens, and caps the detail', () => {
    const error = 'Canvas 后台采集失败：failed at /Users/someone/project/.local/lms/runs/x/canvas.json reading https://canvas.example.edu/api/v1/courses/1/assignments?access_token=abc123&per_page=100 cookie: _session=abcdef Authorization: Bearer 0123456789abcdef0123456789abcdef';
    const reason = collectorFailureReason({ ...canvas, code: 1, error });
    expect(reason).not.toMatch(/Users|someone|access_token|abc123|_session=abcdef|0123456789abcdef/);
    expect(reason).toContain('https://canvas.example.edu/api/v1/courses/1/assignments');
    expect(reason).toContain('<path>');
    expect(sanitiseDetail('x'.repeat(500)).length).toBeLessThanOrEqual(160);
    expect(sanitiseDetail('C:\\Users\\someone\\file.json failed')).toBe('<path> failed');
    // Paths with spaces, quoted or not, and file URLs.
    expect(sanitiseDetail("open '/Users/Some One/proj/.local/x.json' failed")).toBe("open '<path>' failed");
    expect(sanitiseDetail('cannot read /Users/Some One/proj/x.json now')).toBe('cannot read <path> now');
    expect(sanitiseDetail('cannot read /Users/Some Other One/proj/x.json now')).toBe('cannot read <path> now');
    expect(sanitiseDetail('at file:///Users/someone/proj/x.mjs:1:2 here')).not.toMatch(/someone|Users/);
  });

  it('keeps only the message of an uncaught Node error', () => {
    const stderr = [
      'file:///Users/someone/proj/scripts/sources/ed/collect.mjs:21',
      "if (!key.year) throw new Error('无法确定 Ed 的年份与学期');",
      '                     ^',
      '',
      'Error: 无法确定 Ed 的年份与学期',
      '    at file:///Users/someone/proj/scripts/sources/ed/collect.mjs:21:21',
      '    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)',
      '',
      'Node.js v24.15.0',
    ].join('\n');
    expect(collectorFailureReason({ source: 'ed', label: 'Ed', code: 1, error: stderr })).toBe('Ed 采集失败：无法确定 Ed 的年份与学期');
  });
});

describe('translateReason', () => {
  it('keeps Chinese and translates known phrases to English', () => {
    const reason = 'Canvas 数据未能读取（Canvas 登录已失效，请在 Edge 里重新登录 Canvas）；部分 Ed 数据未能读取；2 项权重或规则无出处';
    expect(translateReason(reason, 'zh')).toBe(reason);
    expect(translateReason(reason, 'en')).toBe('Canvas data could not be read (Canvas sign-in has expired. Sign in to Canvas again in Edge); Some Ed data could not be read; 2 weights or rules have no source');
    expect(translateReason('Canvas 登录已失效，请在 专用浏览器 里重新登录 Canvas', 'en')).toBe('Canvas sign-in has expired. Sign in to Canvas again in the dedicated browser');
  });
});
