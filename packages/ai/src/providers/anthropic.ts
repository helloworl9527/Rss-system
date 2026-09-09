import type { Provider, CompleteRequest, CompleteResult, ProviderConfig, Strictness } from '../types.ts';
import { ProviderError } from '../types.ts';

/**
 * Anthropic Messages API 适配器。
 *
 * 用官方 SDK（@anthropic-ai/sdk）而不是自己拼 HTTP —— 官方 SDK 负责
 * 重试、类型、错误分类，且 API 演进时不会悄悄写错线路格式。
 * SDK 走动态 import 懒加载：只有真的配置成 anthropic 才会进内存
 * （896 MB 机器上这点很重要）。
 *
 * 结构化输出用原生 output_config.format（不是旧的 output_format 参数，
 * 也不需要用 tool-use 去绕），供应商侧保证符合 schema → strictness='strict'。
 *
 * 缓存口径：Anthropic 区分「写入缓存」与「读取缓存」两个计费档，
 * 分别映射到 cacheWriteTokens / cachedInputTokens。
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic' as const;
  readonly model;
  readonly strictness: Strictness;
  #cfg: ProviderConfig;
  #client: any = null;

  constructor(cfg: ProviderConfig) {
    this.model = cfg.model;
    this.strictness = cfg.strictness ?? 'strict';
    this.#cfg = cfg;
  }

  async #getClient(): Promise<any> {
    if (this.#client) return this.#client;
    let Anthropic: any;
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch {
      throw new ProviderError('bad_request',
        '未安装 @anthropic-ai/sdk。执行 npm i @anthropic-ai/sdk 后再用 anthropic 供应商。');
    }
    // 不传 apiKey 时 SDK 自行从 ANTHROPIC_API_KEY / auth profile 解析
    const options: Record<string, unknown> = {};
    if (this.#cfg.apiKey) options.apiKey = this.#cfg.apiKey;
    if (this.#cfg.baseUrl) options.baseURL = this.#cfg.baseUrl.replace(/\/$/, '');
    this.#client = new Anthropic(options);
    return this.#client;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const client = await this.#getClient();
    const system = req.cachePrefix
      ? [{ type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } }]
      : req.systemPrompt;

    let resp: any;
    try {
      resp = await client.messages.create({
        model: this.model,
        max_tokens: req.maxOutputTokens,
        system,
        output_config: {
          format: { type: 'json_schema', name: req.schemaName, schema: req.schema },
        },
        messages: [{ role: 'user', content: req.userContent }],
      });
    } catch (e: any) {
      throw mapAnthropicError(e);
    }

    // 安全护栏：拒答时 content 可能为空，必须先看 stop_reason
    if (resp.stop_reason === 'refusal')
      throw new ProviderError('refusal',
        `模型拒答：${resp.stop_details?.category ?? 'unknown'} ${resp.stop_details?.explanation ?? ''}`);

    const text = (resp.content ?? [])
      .filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    let data: unknown;
    try { data = JSON.parse(text); }
    catch { throw new ProviderError('bad_request', `响应不是合法 JSON（前 200 字）: ${text.slice(0, 200)}`); }

    const u = resp.usage ?? {};
    return {
      data, rawText: text, responseId: resp.id ?? '', model: resp.model ?? this.model,
      stopReason: resp.stop_reason,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cachedInputTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

function mapAnthropicError(e: any): ProviderError {
  const s = e?.status;
  if (s === 429) return new ProviderError('rate_limited', String(e?.message ?? e), s);
  if (s === 401 || s === 403) return new ProviderError('auth', String(e?.message ?? e), s);
  if (typeof s === 'number' && s >= 500) return new ProviderError('server', String(e?.message ?? e), s);
  if (typeof s === 'number') return new ProviderError('bad_request', String(e?.message ?? e), s);
  return new ProviderError('network', String(e?.message ?? e));
}
