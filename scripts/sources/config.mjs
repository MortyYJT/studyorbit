// The collector configuration (openspec change generic-adapters, design §1, decision #440): one environment variable,
// STUDYORBIT_SOURCE_CONFIG, holding JSON validated with zod in the child. It never holds a credential. A collector
// started without it (by hand, or by an old caller) uses today's setup: UniMelb, its Canvas, Ed region `auto` and Edge
// through Apple Events. Until the settings file arrives (PR 3) the only accepted values are those of that setup.
import { z } from 'zod';
import { UNIMELB_CANVAS_ORIGIN } from '../institutions/unimelb/index.mjs';

export const SOURCE_CONFIG_ENV = 'STUDYORBIT_SOURCE_CONFIG';
export const MISSING_CONFIG_OFF_MACOS = '请通过 StudyOrbit 启动，或设置 STUDYORBIT_SOURCE_CONFIG';

/**
 * A Canvas origin: `https:`, no user information, no path other than `/`, no query or fragment, not an IP address
 * literal; returned as `URL.origin`. Throws otherwise.
 */
export function canvasOrigin(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('Canvas 地址无效'); }
  const host = url.hostname;
  const ipLiteral = host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host) || /^[0-9.]+$/.test(host) || /^0x/i.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash
    || /[?#]/.test(String(value)) || ipLiteral || !host.includes('.')) throw new Error('Canvas 地址必须是 https:// 开头的网站地址，不含路径');
  return url.origin;
}

export const SourceConfigSchema = z.object({
  version: z.literal(1),
  institution: z.enum(['unimelb']),
  canvasOrigin: z.string().refine(value => { try { return canvasOrigin(value) === value; } catch { return false; } }, 'invalid Canvas origin'),
  browser: z.enum(['edge-applescript']),
  browserPath: z.null(),
  edRegion: z.enum(['auto']),
  profileDir: z.null(),
}).strict();

/** Today's setup, used when the variable is missing. */
export const DEFAULT_SOURCE_CONFIG = Object.freeze({
  version: 1, institution: 'unimelb', canvasOrigin: UNIMELB_CANVAS_ORIGIN, browser: 'edge-applescript', browserPath: null, edRegion: 'auto', profileDir: null,
});

/** The environment a collector command carries. */
export const sourceConfigEnv = config => ({ [SOURCE_CONFIG_ENV]: JSON.stringify(SourceConfigSchema.parse(config)) });

/**
 * The collector's configuration from `env`. Missing: today's setup, except that a collector that needs the browser
 * refuses to guess off macOS (`needsBrowser`). Invalid: an error, never a silent fallback.
 */
export function readSourceConfig({ env = process.env, platform = process.platform, needsBrowser = false } = {}) {
  const raw = env[SOURCE_CONFIG_ENV];
  if (raw === undefined || raw === '') {
    if (needsBrowser && platform !== 'darwin') throw new Error(MISSING_CONFIG_OFF_MACOS);
    return { ...DEFAULT_SOURCE_CONFIG };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${SOURCE_CONFIG_ENV} 不是有效的 JSON`); }
  const result = SourceConfigSchema.safeParse(parsed);
  if (!result.success) throw new Error(`${SOURCE_CONFIG_ENV} 无效：${result.error.issues.map(issue => issue.path.join('.') || issue.message).join('、')}`);
  return result.data;
}
