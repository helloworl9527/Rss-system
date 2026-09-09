import type { Provider, CompleteRequest, CompleteResult, ProviderConfig, Strictness } from '../types.ts';
import { ProviderError } from '../types.ts';

/**
 * OpenAI 兼容线路格式。一份实现覆盖多家：
 *   OpenAI   https://api.openai.com/v1
 *   DeepSeek https://api.deepseek.com/v1
 *   Qwen     https://dashscope.aliyuncs.com/compatible-mode/v1
 *
 * 结构化输出强度按厂商差异处理：
 *   · OpenAI 支持 response_format.json_schema + strict:true  → strictness='strict'
 *   · DeepSeek 目前只有 json_object（JSON 模式，不校验 schema） → strictness='json'
 *   · Qwen 视模型而定，默认按 json 处理，可用配置覆盖为 strict
 * strictness='json' 时上层必须自己做 Schema 校验并重试 —— 这正是
 * PRD 15.3 / FR-044 要求的行为。
 */
const DEFAULT_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};
const DEFAULT_STRICTNESS: Record<string, Strictness> = {
  openai: 'strict', openai_compatible: 'json', deepseek: 'json', qwen: 'json',
};

/**
 * 兼容部分 OpenAI 兼容网关忽略 response_format 的情况：模型可能把合法
 * JSON 包进 Markdown 围栏，或在前后加一句说明。先接受纯 JSON，再从围栏
 * 或正文中提取首个括号平衡的 JSON 值；字符串内的括号不会干扰扫描。
 */
export function parseJsonResponse(text: string): unknown {
  const input = String(text ?? '').trim();
  if (!input) throw new SyntaxError('empty response');

  try { return JSON.parse(input); } catch { /* 继续兼容解析 */ }

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  for (let m = fenced.exec(input); m; m = fenced.exec(input)) {
    try { return JSON.parse(m[1]!.trim()); } catch { /* 尝试正文中的 JSON */ }
  }

  for (let start = 0; start < input.length; start++) {
    const opener = input[start];
    if (opener !== '{' && opener !== '[') continue;
    const closer = opener === '{' ? '}' : ']';
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let i = start; i < input.length; i++) {
      const ch = input[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') {
        if (stack.pop() !== ch) break;
        if (!stack.length) {
          try { return JSON.parse(input.slice(start, i + 1)); } catch { break; }
        }
      }
    }
    void closer;
  }
  throw new SyntaxError('no valid JSON value found');
}

export class OpenAICompatProvider implements Provider {
  readonly name;
  readonly model;
  readonly strictness: Strictness;
  #key: string;
  #base: string;
  #timeout: number;

  constructor(cfg: ProviderConfig) {
    this.name = cfg.provider;
    this.model = cfg.model;
    this.strictness = cfg.strictness ?? DEFAULT_STRICTNESS[cfg.provider] ?? 'json';
    if (cfg.provider === 'openai_compatible' && !cfg.baseUrl)
      throw new ProviderError('bad_request', 'OpenAI 兼容格式必须填写 Base URL（例如 https://api.example.com/v1）');
    this.#base = (cfg.baseUrl ?? DEFAULT_BASE[cfg.provider] ?? DEFAULT_BASE.openai!).replace(/\/$/, '');
    this.#timeout = cfg.timeoutMs ?? 90_000;
    if (!cfg.apiKey) throw new ProviderError('auth', `${cfg.provider} 缺少 API key`);
    this.#key = cfg.apiKey;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    // strict 走 json_schema，其余降级到 json_object 并把 schema 写进提示词
    const responseFormat = this.strictness === 'strict'
      ? { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.schema } }
      : { type: 'json_object' };
    const system = this.strictness === 'strict'
      ? req.systemPrompt
      : `${req.systemPrompt}\n\n必须只输出符合以下 JSON Schema 的 JSON，不要任何解释文字：\n${JSON.stringify(req.schema)}`;

    const body = {
      model: this.model,
      max_tokens: req.maxOutputTokens,
      response_format: responseFormat,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: req.userContent },
      ],
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#timeout);
    let r: Response;
    try {
      r = await fetch(`${this.#base}/chat/completions`, {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#key}` },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw new ProviderError(e?.name === 'AbortError' ? 'timeout' : 'network', String(e?.message ?? e));
    } finally { clearTimeout(timer); }

    if (!r.ok) throw toError(r.status, await r.text().catch(() => ''));
    const j: any = await r.json();
    const choice = j.choices?.[0];
    const text = choice?.message?.content ?? '';

    // 截断要与"模型乱回"区分开：前者应缩短输入重试，后者是提示词问题
    if (choice?.finish_reason === 'length')
      throw new ProviderError('truncated',
        `输出被 max_tokens 截断（已生成 ${j.usage?.completion_tokens ?? '?'} token）`);

    let data: unknown;
    try { data = parseJsonResponse(text); }
    catch {
      const hint = text ? `（前 200 字）: ${String(text).slice(0, 200)}` : '（响应体为空）';
      throw new ProviderError('bad_request', `响应不是合法 JSON${hint}`);
    }

    const u = j.usage ?? {};
    return {
      data, rawText: text, responseId: j.id ?? '', model: j.model ?? this.model,
      stopReason: choice?.finish_reason,
      usage: {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        // OpenAI: prompt_tokens_details.cached_tokens；DeepSeek: prompt_cache_hit_tokens
        cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
        cacheWriteTokens: 0,
      },
    };
  }
}

export function toError(status: number, body: string): ProviderError {
  const msg = body.slice(0, 300);
  if (status === 429) return new ProviderError('rate_limited', `HTTP 429 ${msg}`, status);
  if (status === 401 || status === 403) return new ProviderError('auth', `HTTP ${status} ${msg}`, status);
  if (status >= 500) return new ProviderError('server', `HTTP ${status} ${msg}`, status);
  return new ProviderError('bad_request', `HTTP ${status} ${msg}`, status);
}
