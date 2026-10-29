import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, parsePort } from './server/ports.ts';
import { localApiProxy, previewWithoutApi } from './server/proxy.ts';

// The page only. Every `/api/local/*` route runs in the standalone local API (`server/`, design §2), which
// `npm run dev` (scripts/dev.mjs) starts first with a per-launch token; Vite proxies to it (server/proxy.ts).
export default defineConfig(({ command, isPreview }) => {
  const token = process.env.STUDYORBIT_API_TOKEN;
  if (command === 'serve' && !isPreview && !token) throw new Error('请用 npm run dev 启动（需要本地接口服务）');
  const webPort = parsePort(process.env, 'STUDYORBIT_WEB_PORT', DEFAULT_WEB_PORT);
  const apiPort = parsePort(process.env, 'STUDYORBIT_API_PORT', DEFAULT_API_PORT);
  const proxy: Record<string, ProxyOptions> = token ? { '/api/local': localApiProxy({ apiPort, token }) } : {};
  return {
    root: 'web',
    plugins: [react(), previewWithoutApi()],
    // Loopback only, fixed port, no CORS (the API is same-origin through the proxy; HMR uses the WebSocket).
    // The proxy entry exists only with a token, so no request ever carries an undefined token header.
    server: { cors: false, host: 'localhost', port: webPort, strictPort: true, proxy },
    // Preview would inherit server.proxy; it has no API, so `/api/local` answers 404 (previewWithoutApi).
    preview: { proxy: {} },
    build: { outDir: '../dist', emptyOutDir: true },
  };
});
