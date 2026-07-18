import type {
  ClaudianSettings,
  CodexModelProvider,
  CodexPerformanceMode,
  CodexReasoningEffort,
} from '../types';
import { CODEX_PERFORMANCE_PROFILES } from '../types';

const CUSTOM_PROVIDER_ID = 'second_brain_custom';
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const CODEX_MODEL_PROVIDER_LABELS: Record<CodexModelProvider, string> = {
  codex: 'Codex 账户',
  ollama: 'Ollama（本地）',
  lmstudio: 'LM Studio（本地）',
  custom: '自定义 Responses API',
};

export interface CodexRuntimeProfile {
  provider: CodexModelProvider;
  providerLabel: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  rootArgs: string[];
  execConfigArgs: string[];
}

type ModelProviderSettings = Pick<ClaudianSettings,
  | 'codexModelProvider'
  | 'codexProviderApiKeyEnvVar'
  | 'codexProviderBaseUrl'
  | 'codexProviderDeepModel'
  | 'codexProviderFastModel'
  | 'codexProviderSupportsReasoning'
>;

function quoteToml(value: string): string {
  return JSON.stringify(value);
}

function normalizeCustomBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, '');
  if (!trimmed) {
    throw new Error('请填写自定义模型服务的 API 基础地址。');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('模型服务地址无效，请填写完整的 http:// 或 https:// 地址。');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('模型服务地址只允许使用 http:// 或 https://。');
  }
  if (parsed.username || parsed.password) {
    throw new Error('不要把密钥写进模型服务地址，请使用环境变量。');
  }
  return trimmed;
}

function getExternalModel(settings: ModelProviderSettings, mode: CodexPerformanceMode): string {
  const provider = settings.codexModelProvider ?? 'codex';
  const fastModel = settings.codexProviderFastModel?.trim() ?? '';
  const deepModel = settings.codexProviderDeepModel?.trim() ?? '';
  const model = mode === 'deep' ? (deepModel || fastModel) : fastModel;
  if (!model) {
    throw new Error(`请先为${CODEX_MODEL_PROVIDER_LABELS[provider]}填写模型名称。`);
  }
  return model;
}

export function getConfiguredModel(
  settings: ModelProviderSettings,
  mode: CodexPerformanceMode,
): string {
  if ((settings.codexModelProvider ?? 'codex') === 'codex') {
    return CODEX_PERFORMANCE_PROFILES[mode].model;
  }
  return getExternalModel(settings, mode);
}

export function buildCodexRuntimeProfile(
  settings: ModelProviderSettings,
  mode: CodexPerformanceMode,
  requestedModel?: string,
): CodexRuntimeProfile {
  const provider = settings.codexModelProvider ?? 'codex';
  const defaultProfile = CODEX_PERFORMANCE_PROFILES[mode];
  const model = requestedModel?.trim()
    || (provider === 'codex' ? defaultProfile.model : getExternalModel(settings, mode));
  const rootArgs: string[] = [];

  if (provider === 'ollama' || provider === 'lmstudio') {
    rootArgs.push('--oss', '-c', `oss_provider=${quoteToml(provider)}`);
  } else if (provider === 'custom') {
    const baseUrl = normalizeCustomBaseUrl(settings.codexProviderBaseUrl ?? '');
    const envKey = settings.codexProviderApiKeyEnvVar?.trim() ?? '';
    if (envKey && !ENV_KEY_PATTERN.test(envKey)) {
      throw new Error('API 密钥环境变量名格式无效，例如应填写 OPENAI_API_KEY。');
    }
    rootArgs.push(
      '-c', `model_provider=${quoteToml(CUSTOM_PROVIDER_ID)}`,
      '-c', `model_providers.${CUSTOM_PROVIDER_ID}.name=${quoteToml('第二大脑自定义模型')}`,
      '-c', `model_providers.${CUSTOM_PROVIDER_ID}.base_url=${quoteToml(baseUrl)}`,
      '-c', `model_providers.${CUSTOM_PROVIDER_ID}.wire_api=${quoteToml('responses')}`,
    );
    if (envKey) {
      rootArgs.push('-c', `model_providers.${CUSTOM_PROVIDER_ID}.env_key=${quoteToml(envKey)}`);
    }
  }

  const reasoningEffort = provider === 'codex' || settings.codexProviderSupportsReasoning
    ? defaultProfile.reasoningEffort
    : '';
  const execConfigArgs: string[] = [];
  if (reasoningEffort) {
    execConfigArgs.push('-c', `model_reasoning_effort=${quoteToml(reasoningEffort)}`);
    execConfigArgs.push('-c', `plan_mode_reasoning_effort=${quoteToml(reasoningEffort)}`);
  }

  return {
    provider,
    providerLabel: CODEX_MODEL_PROVIDER_LABELS[provider],
    model,
    reasoningEffort,
    rootArgs,
    execConfigArgs,
  };
}

export function getModelProviderModelsEndpoint(settings: ModelProviderSettings): string | null {
  switch (settings.codexModelProvider ?? 'codex') {
    case 'codex':
      return null;
    case 'ollama':
      return 'http://127.0.0.1:11434/api/tags';
    case 'lmstudio':
      return 'http://127.0.0.1:1234/v1/models';
    case 'custom': {
      const baseUrl = normalizeCustomBaseUrl(settings.codexProviderBaseUrl ?? '');
      return `${baseUrl}/models`;
    }
  }
}

export function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const candidates = Array.isArray(record.models) ? record.models : record.data;
  if (!Array.isArray(candidates)) return [];

  return candidates
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const model = item as Record<string, unknown>;
      if (typeof model.id === 'string') return model.id;
      if (typeof model.name === 'string') return model.name;
      if (typeof model.model === 'string') return model.model;
      return '';
    })
    .filter((value): value is string => Boolean(value));
}
