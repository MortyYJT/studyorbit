// Local store for the course-analysis model choice (decision #229).
// The file lives in the ignored `.local/config/llm.json` with mode 0600. The API key is write-only:
// nothing in this module returns it except `resolveAnalysisConfig`, which the runner uses server-side.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const PROVIDERS = /** @type {const} */ (['deepseek', 'openai-compatible', 'anthropic', 'codex']);
/** Default model per provider; openai-compatible has none and needs an explicit model. */
export const DEFAULT_MODELS = { deepseek: 'deepseek-flash', 'openai-compatible': null, anthropic: 'claude-sonnet-5-5', codex: 'gpt-6-luna' };
/** Vendor-specific key variables that always apply to their own provider. */
const VENDOR_KEYS = { deepseek: 'DEEPSEEK_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

export class LlmConfigValidationError extends Error {
  /** @param {Record<string, string>} fieldErrors */
  constructor(fieldErrors) { super('INVALID_LLM_CONFIG'); this.name = 'LlmConfigValidationError'; this.fieldErrors = fieldErrors; }
}

export function configPath(projectDir) { return join(projectDir, '.local', 'config', 'llm.json'); }

/** True for https URLs and plain-http loopback URLs; other schemes would expose the key in transit. */
export function isAllowedEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}

const optionalText = z.string().trim().optional().transform(value => value || undefined);
const InputSchema = z.object({
  provider: z.enum(PROVIDERS, { error: 'invalid_provider' }),
  model: optionalText.pipe(z.string().max(200, 'too_long').regex(/^\S+$/, 'whitespace').optional()),
  baseUrl: optionalText.pipe(z.string().max(2000, 'too_long').optional()),
  apiKey: z.string().optional().transform(value => value?.trim() || undefined).pipe(z.string().max(500, 'too_long').regex(/^\S+$/, 'whitespace').optional()),
  clearKey: z.boolean().optional(),
}).strict();

const StoredSchema = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().max(200).optional(),
  baseUrl: z.string().max(2000).optional(),
  apiKey: z.string().max(500).optional(),
  updatedAt: z.string(),
});

/** Read the saved settings, or null when there are none (a missing or unreadable file counts as none). */
export async function readLlmConfig(projectDir) {
  try {
    const parsed = StoredSchema.safeParse(JSON.parse(await readFile(configPath(projectDir), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

function originOf(value) { try { return new URL(value).origin; } catch { return null; } }

/**
 * Validate and save settings. An omitted or empty `apiKey` keeps the stored key, but only while the provider
 * (and, for openai-compatible, the endpoint origin) is unchanged, so a key is never sent to a different vendor.
 * `clearKey: true` removes the stored key. Throws LlmConfigValidationError with per-field error codes.
 */
export async function saveLlmConfig(projectDir, input) {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.code === 'unrecognized_keys' ? 'form' : String(issue.path[0] ?? 'form');
      fieldErrors[field] ??= issue.code === 'unrecognized_keys' ? 'unknown_field' : issue.code === 'invalid_value' && field === 'provider' ? 'invalid_provider' : issue.message;
    }
    throw new LlmConfigValidationError(fieldErrors);
  }
  const data = parsed.data;
  const fieldErrors = {};
  if (data.provider === 'openai-compatible') {
    if (!data.baseUrl) fieldErrors.baseUrl = 'required';
    else if (!isAllowedEndpoint(data.baseUrl)) fieldErrors.baseUrl = originOf(data.baseUrl) ? 'insecure_url' : 'invalid_url';
    if (!data.model) fieldErrors.model = 'required';
  }
  if (Object.keys(fieldErrors).length) throw new LlmConfigValidationError(fieldErrors);

  const previous = await readLlmConfig(projectDir);
  const baseUrl = data.provider === 'openai-compatible' ? data.baseUrl : undefined;
  const sameTarget = previous?.provider === data.provider && (data.provider !== 'openai-compatible' || originOf(previous.baseUrl ?? '') === originOf(baseUrl ?? ''));
  const apiKey = data.provider === 'codex' || data.clearKey ? undefined : data.apiKey ?? (sameTarget ? previous?.apiKey : undefined);
  const next = { provider: data.provider, ...(data.model ? { model: data.model } : {}), ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}), updatedAt: new Date().toISOString() };

  const file = configPath(projectDir);
  await mkdir(join(projectDir, '.local', 'config'), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch (error) { await rm(temp, { force: true }); throw error; }
  return next;
}

function envProvider(env) {
  const value = env.COURSE_ANALYSIS_PROVIDER;
  return PROVIDERS.includes(value) ? value : null;
}

function keyFor(provider, stored, env, generic) {
  if (provider === 'codex') return { key: null, source: 'none' };
  if (stored?.apiKey) return { key: stored.apiKey, source: 'settings' };
  const fromEnv = (generic ? env.COURSE_ANALYSIS_API_KEY : undefined) || (VENDOR_KEYS[provider] ? env[VENDOR_KEYS[provider]] : undefined);
  return fromEnv ? { key: fromEnv, source: 'env' } : { key: null, source: 'none' };
}

/**
 * Resolve the effective analysis config from saved settings and environment variables.
 * Precedence: saved settings > environment variables > defaults. The generic COURSE_ANALYSIS_MODEL / _URL /
 * _API_KEY variables apply only when COURSE_ANALYSIS_PROVIDER (default deepseek) names the resolved provider;
 * for openai-compatible the generic key is also limited to the origin of COURSE_ANALYSIS_URL.
 * Vendor variables (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY) always apply to their own provider.
 * An unrecognised COURSE_ANALYSIS_PROVIDER without saved settings resolves with `invalidProvider: true`
 * and no key, so nothing is sent to a guessed vendor.
 */
export function resolveFromStored(stored, env) {
  return explain(stored, env).resolved;
}

function explain(stored, env) {
  const fromEnv = envProvider(env);
  if (!stored && env.COURSE_ANALYSIS_PROVIDER && !fromEnv) {
    return { resolved: { provider: 'deepseek', model: DEFAULT_MODELS.deepseek, baseUrl: null, apiKey: null, invalidProvider: true }, source: 'env', keySource: 'none' };
  }
  const provider = stored?.provider ?? fromEnv ?? 'deepseek';
  const source = stored ? 'settings' : fromEnv ? 'env' : 'default';
  const generic = (fromEnv ?? 'deepseek') === provider;
  const model = stored?.model || (generic ? env.COURSE_ANALYSIS_MODEL : undefined) || DEFAULT_MODELS[provider] || null;
  const baseUrl = provider === 'openai-compatible' ? stored?.baseUrl || (generic ? env.COURSE_ANALYSIS_URL : undefined) || null : null;
  const genericKey = generic && (provider !== 'openai-compatible' || (originOf(baseUrl ?? '') !== null && originOf(baseUrl ?? '') === originOf(env.COURSE_ANALYSIS_URL ?? '')));
  const { key, source: keySource } = keyFor(provider, stored, env, genericKey);
  return { resolved: { provider, model, baseUrl, apiKey: key }, source, keySource };
}

export async function resolveAnalysisConfig(projectDir, env = process.env) {
  return resolveFromStored(await readLlmConfig(projectDir), env);
}

/** Settings view for the UI. Never includes the key. */
export function publicLlmConfig(stored, env = process.env) {
  const { resolved, source, keySource } = explain(stored, env);
  return {
    provider: resolved.provider,
    source,
    model: stored?.model ?? '',
    baseUrl: stored?.baseUrl ?? '',
    effectiveModel: resolved.model,
    effectiveBaseUrl: resolved.baseUrl,
    defaultModel: DEFAULT_MODELS[resolved.provider],
    defaultModels: DEFAULT_MODELS,
    keyRequired: resolved.provider !== 'codex',
    hasKey: keySource !== 'none',
    keySource,
    updatedAt: stored?.updatedAt ?? null,
    ...(resolved.invalidProvider ? { providerInvalid: true } : {}),
  };
}

/** Error code when the resolved config cannot run, or null when it is complete. */
export function configProblem(config) {
  if (config.invalidProvider) return 'ANALYSIS_PROVIDER_INVALID';
  if (config.provider !== 'codex' && !config.apiKey) return 'ANALYSIS_KEY_MISSING';
  if (config.provider === 'openai-compatible' && (!config.baseUrl || !config.model)) return 'ANALYSIS_CONFIG_INCOMPLETE';
  if (config.provider === 'openai-compatible' && !isAllowedEndpoint(config.baseUrl)) return 'ANALYSIS_URL_INSECURE';
  return null;
}
