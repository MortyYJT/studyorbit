import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { READ_EXPRESSIONS } from '../scripts/browser/bridge.mjs';
import { assertAllowedCommand, CDP_ALLOWED_METHODS, CDP_EXPRESSIONS, createCdpPipe, STATE_EXPRESSION } from '../scripts/browser/cdp-pipe.mjs';

// The experimental CDP bridge's pipe transport and method allowlist (openspec change generic-adapters, design §7,
// decision #446): NUL-separated JSON over two fake streams. Never a real browser.

/** Two fake pipe ends: `toBrowser` collects what the transport writes, `fromBrowser` feeds it replies. */
function fakePipe() {
  const toBrowser = new PassThrough(), fromBrowser = new PassThrough();
  const written: Buffer[] = [];
  toBrowser.on('data', chunk => written.push(chunk));
  const frames = () => Buffer.concat(written).toString('utf8').split('\0').filter(Boolean).map(text => JSON.parse(text));
  const reply = (value: unknown) => fromBrowser.write(`${JSON.stringify(value)}\0`);
  return { toBrowser, fromBrowser, written, frames, reply };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('CDP pipe transport', () => {
  it('writes one NUL-terminated JSON frame per command with increasing ids', async () => {
    const pipe = fakePipe();
    const cdp = createCdpPipe({ input: pipe.fromBrowser, output: pipe.toBrowser });
    const first = cdp.send('Target.getTargetInfo', {});
    const second = cdp.send('Target.closeTarget', { targetId: 'T1' });
    await tick();
    expect(Buffer.concat(pipe.written).toString('utf8')).toBe('{"id":1,"method":"Target.getTargetInfo","params":{}}\0{"id":2,"method":"Target.closeTarget","params":{"targetId":"T1"}}\0');
    pipe.reply({ id: 1, result: { targetInfo: { url: 'about:blank' } } });
    pipe.reply({ id: 2, result: { success: true } });
    await expect(first).resolves.toEqual({ targetInfo: { url: 'about:blank' } });
    await expect(second).resolves.toEqual({ success: true });
    cdp.dispose();
  });

  it('matches responses that arrive out of order and frames split across chunks', async () => {
    const pipe = fakePipe();
    const cdp = createCdpPipe({ input: pipe.fromBrowser, output: pipe.toBrowser });
    const one = cdp.send('Target.getTargetInfo', { targetId: 'A' });
    const two = cdp.send('Target.getTargetInfo', { targetId: 'B' });
    await tick();
    const text = `${JSON.stringify({ id: 2, result: { targetInfo: { url: 'b' } } })}\0${JSON.stringify({ method: 'Target.targetInfoChanged', params: {} })}\0${JSON.stringify({ id: 1, result: { targetInfo: { url: 'a' } } })}\0`;
    // Split inside a multi-byte character too: frames are cut on NUL bytes, not on characters.
    const bytes = Buffer.from(text.replace('"b"', '"bé"'));
    for (const cut of [5, 40, bytes.length]) { pipe.fromBrowser.write(bytes.subarray(cut === 5 ? 0 : cut === 40 ? 5 : 40, cut)); await tick(); }
    await expect(two).resolves.toEqual({ targetInfo: { url: 'bé' } });
    await expect(one).resolves.toEqual({ targetInfo: { url: 'a' } });
    cdp.dispose();
  });

  it('rejects a command with the browser\'s error and ignores replies with unknown ids', async () => {
    const pipe = fakePipe();
    const cdp = createCdpPipe({ input: pipe.fromBrowser, output: pipe.toBrowser });
    const failing = cdp.send('Target.closeTarget', { targetId: 'gone' });
    await tick();
    pipe.reply({ id: 99, result: {} });
    pipe.reply({ id: 1, error: { code: -32602, message: 'No target with given id found' } });
    await expect(failing).rejects.toThrow('No target with given id found');
    cdp.dispose();
  });

  it('rejects every pending and later command once the pipe closes', async () => {
    const pipe = fakePipe();
    const closes: unknown[] = [];
    const cdp = createCdpPipe({ input: pipe.fromBrowser, output: pipe.toBrowser });
    cdp.onClose(error => closes.push(error));
    const pending = cdp.send('Target.getTargetInfo', {});
    await tick();
    pipe.fromBrowser.end();
    await expect(pending).rejects.toThrow('专用浏览器已关闭');
    await expect(cdp.send('Target.getTargetInfo', {})).rejects.toThrow('专用浏览器已关闭');
    expect(cdp.closed()).toBe(true);
    expect(closes).toHaveLength(1);
    expect(pipe.frames()).toHaveLength(1);
  });

  it('times out a command that gets no answer and forgets it', async () => {
    const pipe = fakePipe();
    const cdp = createCdpPipe({ input: pipe.fromBrowser, output: pipe.toBrowser, timeoutMs: 20 });
    const slow = cdp.send('Target.getTargetInfo', {});
    await expect(slow).rejects.toThrow('专用浏览器没有响应');
    pipe.reply({ id: 1, result: {} });
    await tick();
    expect(cdp.closed()).toBe(false);
    cdp.dispose();
  });

  it('closes on a frame that is not JSON or a buffer that grows past the limit', async () => {
    const bad = fakePipe();
    const cdp = createCdpPipe({ input: bad.fromBrowser, output: bad.toBrowser });
    const pending = cdp.send('Target.getTargetInfo', {});
    await tick();
    bad.fromBrowser.write('not json\0');
    await expect(pending).rejects.toThrow('专用浏览器');
    expect(cdp.closed()).toBe(true);

    const big = fakePipe();
    const limited = createCdpPipe({ input: big.fromBrowser, output: big.toBrowser, maxFrameBytes: 16 });
    const waiting = limited.send('Target.getTargetInfo', {});
    await tick();
    big.fromBrowser.write('x'.repeat(17));
    await expect(waiting).rejects.toThrow('专用浏览器');
  });
});

describe('CDP method allowlist and constant expressions', () => {
  it('allows exactly the design\'s methods', () => {
    expect([...CDP_ALLOWED_METHODS].sort()).toEqual(['Browser.close', 'Runtime.evaluate', 'Target.attachToTarget', 'Target.closeTarget', 'Target.createTarget', 'Target.getTargetInfo']);
    expect(STATE_EXPRESSION).toBe('document.readyState');
    expect([...CDP_EXPRESSIONS].sort()).toEqual([...Object.values(READ_EXPRESSIONS), 'document.readyState'].sort());
  });

  it('throws before writing for any other method, cookies and storage first', async () => {
    const pipe = fakePipe();
    const cdp = createCdpPipe({ input: pipe.fromBrowser, output: pipe.toBrowser });
    for (const method of ['Network.getAllCookies', 'Network.getCookies', 'Storage.getCookies', 'Storage.clearDataForOrigin', 'Page.navigate', 'Fetch.enable',
      'Browser.setDownloadBehavior', 'Target.exposeDevToolsProtocol', 'Runtime.callFunctionOn', 'DOMStorage.getDOMStorageItems', 'constructor', '__proto__']) {
      await expect(cdp.send(method, {}), method).rejects.toThrow('不在允许列表');
    }
    await tick();
    expect(pipe.written).toEqual([]);
    cdp.dispose();
  });

  it('accepts only the constant expressions, by value, in an attached session', () => {
    for (const expression of CDP_EXPRESSIONS) expect(() => assertAllowedCommand('Runtime.evaluate', { expression, returnByValue: true }, 'S1')).not.toThrow();
    const refused: [Record<string, unknown>, string | undefined][] = [
      [{ expression: 'document.cookie', returnByValue: true }, 'S1'],
      [{ expression: 'localStorage.getItem("token")', returnByValue: true }, 'S1'],
      [{ expression: `${STATE_EXPRESSION} `, returnByValue: true }, 'S1'],
      [{ expression: STATE_EXPRESSION }, 'S1'],
      [{ expression: STATE_EXPRESSION, returnByValue: false }, 'S1'],
      [{ expression: STATE_EXPRESSION, returnByValue: true, awaitPromise: true }, 'S1'],
      [{ expression: STATE_EXPRESSION, returnByValue: true, includeCommandLineAPI: true }, 'S1'],
      [{ expression: STATE_EXPRESSION, returnByValue: true }, undefined],
    ];
    for (const [params, session] of refused) expect(() => assertAllowedCommand('Runtime.evaluate', params, session), JSON.stringify(params)).toThrow();
  });

  it('checks the parameters of the target methods and of Browser.close', () => {
    const ok: [string, Record<string, unknown>][] = [
      ['Target.createTarget', { url: 'https://canvas.example.edu/api/v1/courses', background: true }],
      ['Target.createTarget', { url: 'https://canvas.example.edu/', background: false }],
      ['Target.attachToTarget', { targetId: 'T', flatten: true }],
      ['Target.getTargetInfo', {}], ['Target.getTargetInfo', { targetId: 'T' }],
      ['Target.closeTarget', { targetId: 'T' }], ['Browser.close', {}],
    ];
    for (const [method, params] of ok) expect(() => assertAllowedCommand(method, params), method).not.toThrow();
    const refused: [string, Record<string, unknown>, string?][] = [
      ['Target.createTarget', { url: 'http://canvas.example.edu/', background: true }],
      ['Target.createTarget', { url: 'file:///etc/passwd', background: true }],
      ['Target.createTarget', { url: 'https://canvas.example.edu/', background: true, newWindow: true }],
      ['Target.createTarget', { url: 'https://canvas.example.edu/' }],
      ['Target.attachToTarget', { targetId: 'T' }],
      ['Target.attachToTarget', { targetId: 'T', flatten: false }],
      ['Target.getTargetInfo', { targetId: 5 }],
      ['Target.closeTarget', {}],
      ['Browser.close', { force: true }],
      ['Target.closeTarget', { targetId: 'T' }, 'S1'],
    ];
    for (const [method, params, session] of refused) expect(() => assertAllowedCommand(method, params, session), `${method} ${JSON.stringify(params)}`).toThrow();
  });
});
