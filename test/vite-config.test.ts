import type { ConfigEnv, UserConfig } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import config from '../vite.config.ts';
import { TOKEN_HEADER } from '../server/guard.ts';

// vite.config.ts (design §4, decisions #357, #358): page only, loopback, strict port, proxy only with a token.
const keys = ['STUDYORBIT_API_TOKEN', 'STUDYORBIT_API_PORT', 'STUDYORBIT_WEB_PORT'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = Object.fromEntries(keys.map(key => [key, process.env[key]])); for (const key of keys) delete process.env[key]; });
afterEach(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });

const resolve = (env: Partial<ConfigEnv>) => (config as (env: ConfigEnv) => UserConfig)({ command: 'serve', mode: 'development', isPreview: false, ...env } as ConfigEnv);

describe('vite.config.ts', () => {
  it('refuses the dev server without a token and tells the owner to use npm run dev', () => {
    expect(() => resolve({})).toThrow('请用 npm run dev 启动（需要本地接口服务）');
  });

  it('pins the dev server to localhost on a strict port and proxies /api/local with the token', () => {
    process.env.STUDYORBIT_API_TOKEN = 'c3'.repeat(32);
    process.env.STUDYORBIT_API_PORT = '6190';
    process.env.STUDYORBIT_WEB_PORT = '5181';
    const resolved = resolve({});
    expect(resolved.server).toMatchObject({ cors: false, host: 'localhost', port: 5181, strictPort: true });
    const proxy = (resolved.server!.proxy as Record<string, { target: string; changeOrigin: boolean; headers: Record<string, string> }>)['/api/local']!;
    expect(proxy).toMatchObject({ target: 'http://127.0.0.1:6190', changeOrigin: false, headers: { [TOKEN_HEADER]: 'c3'.repeat(32) } });
    expect(resolved.preview).toEqual({ proxy: {} });
    expect(resolved.plugins).toHaveLength(2);
  });

  it('builds and previews without a token, and preview has no API proxy', () => {
    expect(resolve({ command: 'build', mode: 'production' }).build).toEqual({ outDir: '../dist', emptyOutDir: true });
    const preview = resolve({ isPreview: true, mode: 'production' });
    expect(preview.preview).toEqual({ proxy: {} });
    expect(preview.server!.proxy).toEqual({});
  });
});
