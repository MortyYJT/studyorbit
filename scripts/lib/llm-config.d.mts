export type LlmProvider = 'deepseek' | 'openai-compatible' | 'anthropic' | 'codex';
export const PROVIDERS: readonly LlmProvider[];
export const DEFAULT_MODELS: Record<LlmProvider, string | null>;
export type StoredLlmConfig = { provider: LlmProvider; model?: string; baseUrl?: string; apiKey?: string; updatedAt: string };
export type AnalysisConfig = { provider: LlmProvider; model: string | null; baseUrl: string | null; apiKey: string | null; invalidProvider?: true };
export type PublicLlmConfig = {
  provider: LlmProvider; source: 'settings' | 'env' | 'default'; model: string; baseUrl: string;
  effectiveModel: string | null; effectiveBaseUrl: string | null; defaultModel: string | null; defaultModels: Record<LlmProvider, string | null>;
  keyRequired: boolean; hasKey: boolean; keySource: 'settings' | 'env' | 'none'; updatedAt: string | null; providerInvalid?: true;
};
export class LlmConfigValidationError extends Error { fieldErrors: Record<string, string>; }
export function configPath(projectDir: string): string;
export function isAllowedEndpoint(value: string): boolean;
export function readLlmConfig(projectDir: string): Promise<StoredLlmConfig | null>;
export function saveLlmConfig(projectDir: string, input: unknown): Promise<StoredLlmConfig>;
export function resolveFromStored(stored: StoredLlmConfig | null, env: Record<string, string | undefined>): AnalysisConfig;
export function resolveAnalysisConfig(projectDir: string, env?: Record<string, string | undefined>): Promise<AnalysisConfig>;
export function publicLlmConfig(stored: StoredLlmConfig | null, env?: Record<string, string | undefined>): PublicLlmConfig;
export function configProblem(config: AnalysisConfig): 'ANALYSIS_PROVIDER_INVALID' | 'ANALYSIS_KEY_MISSING' | 'ANALYSIS_CONFIG_INCOMPLETE' | 'ANALYSIS_URL_INSECURE' | null;
