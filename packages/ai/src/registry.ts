import type { Provider, ProviderConfig, ProviderName } from './types.ts';
import { ProviderError } from './types.ts';

/**
 * 按配置构建供应商。适配器全部动态 import —— 只有实际用到的那家
 * 才会被加载进内存（896 MB 机器上这点很重要）。
 *
 * 新增厂商只需在这里加一个分支 + 一个适配器文件，上层零改动。
 */
export async function createProvider(cfg: ProviderConfig): Promise<Provider> {
  switch (cfg.provider) {
    case 'mock': {
      const { MockProvider } = await import('./providers/mock.ts');
      return new MockProvider(cfg);
    }
    case 'openai':
    case 'deepseek':
    case 'qwen': {
      const { OpenAICompatProvider } = await import('./providers/openai-compat.ts');
      return new OpenAICompatProvider(cfg);
    }
    case 'anthropic': {
      const { AnthropicProvider } = await import('./providers/anthropic.ts');
      return new AnthropicProvider(cfg);
    }
    case 'gemini': {
      const { GeminiProvider } = await import('./providers/gemini.ts');
      return new GeminiProvider(cfg);
    }
    default:
      throw new ProviderError('bad_request', '未知供应商: ' + String(cfg.provider));
  }
}

const KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  mock: '',
};

/**
 * 从环境变量解析某一层级（L1/L2/L3）的供应商配置。
 * 层级可以指向不同厂商 —— 例如 L1 用便宜模型批量判定、
 * L2/L3 用强模型复核，这正是 PRD 15.1 分级调用的意图。
 */
export function providerFromEnv(tier: 'L1' | 'L2' | 'L3'): ProviderConfig {
  const provider = (process.env['AI_' + tier + '_PROVIDER']
    ?? process.env.AI_PROVIDER ?? 'mock') as ProviderName;
  const keyName = KEY_ENV[provider];
  return {
    provider,
    model: process.env['AI_' + tier + '_MODEL'] ?? '',
    apiKey: keyName ? process.env[keyName] : undefined,
    baseUrl: process.env['AI_' + tier + '_BASE_URL'] ?? process.env.AI_BASE_URL,
    strictness: process.env['AI_' + tier + '_STRICTNESS'] as ProviderConfig['strictness'],
  };
}
