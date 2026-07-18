import {
  buildCodexRuntimeProfile,
  CUSTOM_PROVIDER_API_KEY_ENV,
  extractModelIds,
  getConfiguredModel,
  getModelProviderModelsEndpoint,
  getModelProviderRuntimeEnvironment,
} from '@/core/model';
import type { ClaudianSettings } from '@/core/types';

function settings(overrides: Partial<ClaudianSettings> = {}): ClaudianSettings {
  return {
    codexModelProvider: 'codex',
    codexProviderApiKeyEnvVar: '',
    codexProviderBaseUrl: '',
    codexProviderSecretId: '',
    codexProviderDeepModel: '',
    codexProviderFastModel: '',
    codexProviderSupportsReasoning: false,
    ...overrides,
  } as ClaudianSettings;
}

describe('CodexModelProvider', () => {
  it('keeps the existing Codex fast and deep profiles as defaults', () => {
    expect(getConfiguredModel(settings(), 'fast')).toBe('gpt-5.6-terra');
    expect(getConfiguredModel(settings(), 'deep')).toBe('gpt-5.6-sol');

    const profile = buildCodexRuntimeProfile(settings(), 'fast');
    expect(profile.rootArgs).toEqual([]);
    expect(profile.execConfigArgs).toEqual([
      '-c', 'model_reasoning_effort="medium"',
      '-c', 'plan_mode_reasoning_effort="medium"',
    ]);
  });

  it('treats settings saved before v3.4 as Codex settings', () => {
    const legacy = settings();
    delete legacy.codexModelProvider;
    expect(getConfiguredModel(legacy, 'fast')).toBe('gpt-5.6-terra');
  });

  it('uses the Codex local-provider switch for Ollama without forcing reasoning parameters', () => {
    const profile = buildCodexRuntimeProfile(settings({
      codexModelProvider: 'ollama',
      codexProviderFastModel: 'qwen3:14b',
    }), 'deep');

    expect(profile.model).toBe('qwen3:14b');
    expect(profile.rootArgs).toEqual(['--oss', '-c', 'oss_provider="ollama"']);
    expect(profile.execConfigArgs).toEqual([]);
    expect(getModelProviderModelsEndpoint(settings({ codexModelProvider: 'ollama' })))
      .toBe('http://127.0.0.1:11434/api/tags');
  });

  it('builds an authenticated custom Responses provider without storing the key', () => {
    const profile = buildCodexRuntimeProfile(settings({
      codexModelProvider: 'custom',
      codexProviderApiKeyEnvVar: 'MY_MODEL_KEY',
      codexProviderBaseUrl: 'https://models.example.com/v1/',
      codexProviderFastModel: 'my-model',
      codexProviderSupportsReasoning: true,
    }), 'fast');

    expect(profile.model).toBe('my-model');
    expect(profile.rootArgs).toEqual(expect.arrayContaining([
      '-c', 'model_provider="second_brain_custom"',
      '-c', 'model_providers.second_brain_custom.base_url="https://models.example.com/v1"',
      '-c', 'model_providers.second_brain_custom.env_key="MY_MODEL_KEY"',
    ]));
    expect(profile.rootArgs.join(' ')).not.toContain('secret');
    expect(profile.execConfigArgs).toContain('model_reasoning_effort="medium"');
  });

  it('injects a securely stored API key only into the child process environment', () => {
    const secureSettings = settings({
      codexModelProvider: 'custom',
      codexProviderBaseUrl: 'https://models.example.com/v1',
      codexProviderSecretId: 'second-brain-model-key',
      codexProviderFastModel: 'my-model',
    });
    const profile = buildCodexRuntimeProfile(secureSettings, 'fast');
    const runtimeEnv = getModelProviderRuntimeEnvironment(secureSettings, {
      getSecret: (id) => id === 'second-brain-model-key' ? 'private-api-key' : null,
    });

    expect(profile.rootArgs).toContain(
      `model_providers.second_brain_custom.env_key="${CUSTOM_PROVIDER_API_KEY_ENV}"`,
    );
    expect(profile.rootArgs.join(' ')).not.toContain('private-api-key');
    expect(runtimeEnv).toEqual({ [CUSTOM_PROVIDER_API_KEY_ENV]: 'private-api-key' });
  });

  it('reports a missing selected secret before launching the model process', () => {
    expect(() => getModelProviderRuntimeEnvironment(settings({
      codexModelProvider: 'custom',
      codexProviderSecretId: 'missing-key',
    }), { getSecret: () => null })).toThrow('未找到已选择的 API 密钥');
  });

  it('rejects unsafe custom URLs and malformed environment variable names', () => {
    expect(() => buildCodexRuntimeProfile(settings({
      codexModelProvider: 'custom',
      codexProviderBaseUrl: 'https://user:secret@example.com/v1',
      codexProviderFastModel: 'model',
    }), 'fast')).toThrow('不要把密钥写进模型服务地址');

    expect(() => buildCodexRuntimeProfile(settings({
      codexModelProvider: 'custom',
      codexProviderApiKeyEnvVar: 'bad-key',
      codexProviderBaseUrl: 'https://example.com/v1',
      codexProviderFastModel: 'model',
    }), 'fast')).toThrow('环境变量名格式无效');
  });

  it('extracts model names from OpenAI-compatible and Ollama responses', () => {
    expect(extractModelIds({ data: [{ id: 'model-a' }] })).toEqual(['model-a']);
    expect(extractModelIds({ models: [{ name: 'qwen3:14b' }, { model: 'gpt-oss:20b' }] }))
      .toEqual(['qwen3:14b', 'gpt-oss:20b']);
  });
});
