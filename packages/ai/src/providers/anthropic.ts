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
    if (this.#cfg.isolated) Object.assign(options, isolatedOptions(this.#cfg));
    else {
      if (this.#cfg.apiKey) options.apiKey = this.#cfg.apiKey;
      if (this.#cfg.baseUrl) options.baseURL = this.#cfg.baseUrl.replace(/\/$/, '');
    }
    // 重试统一由 withTransientRetry 负责（每次实际请求都计入预算）；关闭 SDK 自带的重试，避免叠加与漏计
    options.maxRetries = 0;
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
  // SDK 自带重试已关闭（maxRetries=0），它原本会重试的 408 / 409 要映射成瞬时故障，交给 withTransientRetry
  if (s === 408) return new ProviderError('timeout', String(e?.message ?? e), s);
  if (s === 409) return new ProviderError('server', String(e?.message ?? e), s);
  if (typeof s === 'number' && s >= 500) return new ProviderError('server', String(e?.message ?? e), s);
  if (typeof s === 'number') return new ProviderError('bad_request', String(e?.message ?? e), s);
  return new ProviderError('network', String(e?.message ?? e));
}

/** 允许发出的请求头（其余一律丢弃，包括 ANTHROPIC_CUSTOM_HEADERS 注入的任何头与 authorization）。 */
const ALLOWED_HEADERS = new Set(['content-type', 'accept', 'user-agent', 'anthropic-version', 'anthropic-beta']);

/**
 * 库内配置（全局模型供应商）的 SDK 选项：SDK 会隐式读取 ANTHROPIC_BASE_URL / AUTH_TOKEN / CUSTOM_HEADERS / LOG，
 * 构造参数不足以全部关掉，所以最终请求由这里的 fetch 重建：只发往库里的地址、不跟随重定向、按白名单重建请求头、
 * 鉴权只用库里的密钥。
 */
export function isolatedOptions(cfg: ProviderConfig): Record<string, unknown> {
  const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const key = cfg.apiKey ?? '';
  const isolatedFetch = async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? '');
    if (!(url === base || url.startsWith(base + '/') || url.startsWith(base + '?')))
      throw new ProviderError('bad_request', '请求地址与配置的 Base URL 不一致，已拦截');
    const headers = new Headers();
    new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => {
      const n = k.toLowerCase();
      if (ALLOWED_HEADERS.has(n) || n.startsWith('x-stainless-')) headers.set(n, v);
    });
    headers.set('x-api-key', key);
    return fetch(url, { ...init, headers, redirect: 'error' });
  };
  return { apiKey: key, authToken: null, baseURL: base, logLevel: 'off', fetch: isolatedFetch, defaultHeaders: {}, ...(cfg.timeoutMs ? { timeout: cfg.timeoutMs } : {}) };
}
