import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

/** Every byte from the executable's real stdout pipe participates in framing verification. */
export function assertMcpFrames(stdout: string): Record<string, any>[] {
  return stdout.split('\n').filter(Boolean).map(line => {
    try { const frame = JSON.parse(line); expect(frame).toMatchObject({ jsonrpc: '2.0' }); return frame; }
    catch { throw new Error('Invalid MCP stdout frame'); }
  });
}

export async function mcpChild(preload?: string) {
  const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
  const child = spawn(process.execPath, [...(preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : []), cli, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exited = new Promise<number | null>((resolve, reject) => { child.on('close', code => resolve(code)); child.on('error', reject); });
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const waitFor = async (id: number) => {
      for (let attempt = 0; attempt < 400 && !stdout.split('\n').some(line => line.includes(`"id":${id}`)); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '0' } } });
    await waitFor(1);
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    await waitFor(2);
    send({ id: 3, method: 'tools/call', params: { name: 'policy.record', arguments: { owner: true } } });
    await waitFor(3);
    send({ id: 4, method: 'tools/call', params: { name: 'courses.list', arguments: {} } });
    await waitFor(4);
    child.stdin.end();
    expect(await exited).toBe(0);
    const frames = assertMcpFrames(stdout);
    expect(frames.map(frame => frame.id)).toEqual([1, 2, 3, 4]);
    for (const frame of frames) expect(frame.jsonrpc).toBe('2.0');
    expect(frames[1]!.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('policy.record');
    expect(frames[1]!.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('audit.record');
    expect(JSON.parse(frames[2]!.result.content[0].text)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(JSON.parse(frames[3]!.result.content[0].text)).toMatchObject({ ok: true, data: { items: [] } });
    return { stdout, stderr, frames };
  } finally { child.stdin.destroy(); child.kill(); }
}
