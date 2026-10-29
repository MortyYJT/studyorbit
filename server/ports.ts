// Ports of the two processes (design §2, §4), read from the environment the launcher sets. Shared by
// server/main.ts and vite.config.ts.
export const DEFAULT_API_PORT = 5190;
export const DEFAULT_WEB_PORT = 5173;

/** An integer port from 0 (any free port, for tests) to 65535; unset means the default. */
export function parsePort(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error(`${name} 不是有效端口：${value}`);
  return Number(value);
}
