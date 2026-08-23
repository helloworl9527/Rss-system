import type { Provider, CompleteRequest, CompleteResult, ProviderConfig, Strictness } from '../types.ts';
import { ProviderError } from '../types.ts';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Mock / replay 供应商。
 *
 * 存在的理由不是省钱，而是：很多必须正确处理的失败路径，用真实 API
 * 根本没法按需复现 —— Schema 不合规输出、拒答、截断、预算熔断、超时、
 * 强制保留项被误判为过滤（ESC-005）。这些都是 PRD FR-044 / 15.4 / 15.5
 * 明确要求处理的，PRD 23.2 也直接写明「OpenAI 使用 mock 或录制的结构化
 * 响应，验证 Schema、重试和升级」。
 *
 * 模式：
 *   mock   本地生成，可通过 MOCK_FAULT 注入故障
 *   replay 重放 record 模式录下的真实响应（零成本、可复现）
 */
export type Fault =
  | 'none' | 'invalid_json' | 'schema_violation' | 'refusal'
  | 'rate_limited' | 'timeout' | 'truncated' | 'server_error'
  /** 强制保留预判命中，模型却判为过滤 —— 触发 ESC-005 的场景 */
  | 'wrong_filter';

export class MockProvider implements Provider {
  readonly name = 'mock' as const;
  readonly model;
  readonly strictness: Strictness;
  #fault: Fault;
  #replayDir: string | null;
  /** 每次调用递增，配合 faultOnCall 只在第 N 次注入故障（测重试用） */
  #calls = 0;
  #faultOnCall: number;

  constructor(cfg: ProviderConfig & { fault?: Fault; replayDir?: string; faultOnCall?: number }) {
    this.model = cfg.model || 'mock-model';
    this.strictness = cfg.strictness ?? 'strict';
    this.#fault = cfg.fault ?? (process.env.MOCK_FAULT as Fault) ?? 'none';
    this.#replayDir = cfg.replayDir ?? process.env.AI_REPLAY_DIR ?? null;
    this.#faultOnCall = cfg.faultOnCall ?? 1;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.#calls++;
    const fault = this.#calls === this.#faultOnCall ? this.#fault : 'none';

    if (fault === 'rate_limited') throw new ProviderError('rate_limited', 'mock: 429 限流', 429);
    if (fault === 'timeout') throw new ProviderError('timeout', 'mock: 请求超时');
    if (fault === 'server_error') throw new ProviderError('server', 'mock: 500', 500);
    if (fault === 'refusal') throw new ProviderError('refusal', 'mock: 模型拒答');
    if (fault === 'invalid_json')
      throw new ProviderError('bad_request', 'mock: 响应不是合法 JSON');

    // replay：命中录制文件就返回真实响应
    if (this.#replayDir) {
      const key = createHash('sha256')
        .update(req.systemPrompt + ' ' + req.userContent).digest('hex').slice(0, 32);
      const f = join(this.#replayDir, key + '.json');
      if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as CompleteResult;
    }

    const input = Math.ceil((req.systemPrompt.length + req.userContent.length) / 2.2);
    const data = synth(req, fault);
    const text = JSON.stringify(data);

    return {
      data, rawText: text, responseId: 'mock-' + this.#calls, model: this.model,
      stopReason: fault === 'truncated' ? 'max_tokens' : 'end_turn',
      usage: {
        inputTokens: input,
        outputTokens: Math.ceil(text.length / 2.2),
        cachedInputTokens: req.cachePrefix ? Math.ceil(req.systemPrompt.length / 2.2) : 0,
        cacheWriteTokens: 0,
      },
    };
  }
}

/** 依据请求里的候选，合成一份形状正确的响应。 */
function synth(req: CompleteRequest, fault: Fault): unknown {
  let payload: any = {};
  try { payload = JSON.parse(req.userContent); } catch { /* 非 JSON 用空对象 */ }
  const items: any[] = Array.isArray(payload.candidates) ? payload.candidates : [payload];

  const results = items.map((c: any, i: number) => {
    const pre: string[] = c?.rule_prescreen?.mandatory_classes ?? [];
    const base = {
      candidate_id: c?.candidate_id ?? ('unknown-' + i),
      decision: pre.length ? 'retain' : 'normal',
      mandatory_class: pre[0] ?? 'none',
      section: 'ai_tech',
      event_key: 'mock-evt-' + (c?.candidate_id ?? i),
      confidence: 0.82,
      filter_reason: null,
      escalation_reasons: [] as string[],
    };
    // 强制保留候选被判为过滤 —— 必须触发 ESC-005 升级
    if (fault === 'wrong_filter' && pre.length)
      return { ...base, decision: 'filter', mandatory_class: 'none', filter_reason: '看起来是广告' };
    if (fault === 'schema_violation')
      return { ...base, decision: 'MAYBE', confidence: '很高' };   // 枚举非法 + 类型错误
    return base;
  });
  return { results };
}

/** record 模式：把真实响应存盘供后续 replay。 */
export function recordResponse(dir: string, req: CompleteRequest, res: CompleteResult): void {
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha256')
    .update(req.systemPrompt + ' ' + req.userContent).digest('hex').slice(0, 32);
  writeFileSync(join(dir, key + '.json'), JSON.stringify(res, null, 2));
}
