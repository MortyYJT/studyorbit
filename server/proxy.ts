// Vite `server.proxy` entry for `/api/local` (design §4, decisions #342, #358). Forwards to the local API on
// 127.0.0.1 without changing `Host` (the server's Host and Origin checks see the page's host), sets the per-launch
// token on the server side (replacing any value the browser sent; the token never reaches client code), and refuses
// a non-loopback browser before forwarding: every proxied request reaches the API from 127.0.0.1, so the API's own
// peer check cannot see a LAN client of a dev server started with `--host`.
import type { ProxyOptions } from 'vite';
import { TOKEN_HEADER, isLoopback } from './guard.ts';

export function localApiProxy({ apiPort, token }: { apiPort: number; token: string }): ProxyOptions {
  return {
    target: `http://127.0.0.1:${apiPort}`,
    changeOrigin: false,
    ws: false,
    headers: { [TOKEN_HEADER]: token },
    bypass(req, res) {
      if (isLoopback(req.socket.remoteAddress)) return undefined;
      // Answered here; returning the URL with the response ended makes Vite stop without forwarding.
      res?.writeHead(403).end();
      return req.url ?? '/';
    },
  };
}
