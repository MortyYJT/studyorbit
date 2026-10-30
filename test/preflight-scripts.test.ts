import { describe, expect, it } from 'vitest';
import { collectorFailureReason } from '../shared/sync-reasons.ts';
import { runCollectorScript } from './collector-harness.ts';

// The preflight scripts (sync-incomplete fix 2) run for real against the collector preload's synthetic answers: never
// a browser, the Ed CLI or the network. The Canvas check reads only the HTTP status of `/api/v1/users/self`.
const CANVAS = 'https://canvas.lms.unimelb.edu.au';
const SELF = `${CANVAS}/api/v1/users/self`;
const canvasScript = 'scripts/sources/canvas/preflight.mjs';
const edScript = 'scripts/sources/ed/preflight.mjs';
const reason = (source: string, label: string, run: { code: number | null; stderr: string }) =>
  collectorFailureReason({ source, label, browser: 'edge-applescript', code: run.code, error: run.stderr });

describe('Canvas preflight', () => {
  it('passes on HTTP 200 without printing or writing the response', async () => {
    const run = await runCollectorScript(canvasScript, [], { pages: { [SELF]: { status: 200, body: '{"name":"Synthetic Person","id":1}', link: null } } });
    expect(run.code, run.stderr).toBe(0);
    expect(`${run.stdout}${run.stderr}`).not.toContain('Synthetic Person');
    expect(run.output).toBeNull();
    // One tab on the users/self URL, read with the same-origin JSON read, then closed.
    const tabs = run.calls.filter(call => call.kind === 'osascript' && /make new tab/.test(String(call.script)));
    expect(tabs.map(call => (call.argv as string[])[0])).toEqual([`${SELF}#studyorbit-<uuid>`]);
    expect(run.calls.some(call => /close t$/m.test(String(call.script)))).toBe(true);
  });

  it('fails with an expired sign-in on HTTP 401 and with a missing window', async () => {
    const signedOut = await runCollectorScript(canvasScript, [], { pages: { [SELF]: { status: 401, body: '{"errors":[]}', link: null } } });
    expect(signedOut.code).toBe(1);
    expect(reason('canvas', 'Canvas', signedOut)).toBe('Canvas 登录已失效，请在 Edge 里重新登录 Canvas');
    const noWindow = await runCollectorScript(canvasScript, [], { osascriptError: 'execution error: Microsoft Edge got an error: EDGE_WINDOW_MISSING (-2700)' });
    expect(noWindow.code).toBe(1);
    expect(reason('canvas', 'Canvas', noWindow)).toBe('Edge 没有打开窗口，请打开一个 Edge 窗口后重试');
    const busy = await runCollectorScript(canvasScript, [], { pages: { [SELF]: { status: 503, body: '', link: null } } });
    expect(busy.code).toBe(75);
  });
});

describe('Ed preflight', () => {
  it('passes when signed in, and reports a signed-out or unusable CLI', async () => {
    const ok = await runCollectorScript(edScript, [], { edstem: { 'auth status --json': { authenticated: true, region: 'au' } } });
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.calls).toEqual([{ kind: 'edstem', args: ['auth', 'status', '--json'] }]);
    const out = await runCollectorScript(edScript, [], { edstem: { 'auth status --json': { authenticated: false } } });
    expect(out.code).toBe(1);
    expect(reason('ed', 'Ed', out)).toBe('Ed 未登录，请在终端运行 edstem auth login 后重试');
    const broken = await runCollectorScript(edScript, [], { edstem: {} });
    expect(broken.code).toBe(1);
    expect(reason('ed', 'Ed', broken)).toMatch(/^Ed 采集失败：/);
  });
});
