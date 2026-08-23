import type { Provider, CompleteResult } from './types.ts';
import { ProviderError } from './types.ts';
import { COMPOSE_SCHEMA, validate, type ComposeResult } from './schema.ts';

/**
 * 第二段：只为最终入选条目生成成品文案（PRD 9.2）。
 *
 * 复用优先：L2/L3 复核时已顺带产出 conclusion 与 summary_sentences，
 * 那些条目不再调模型 —— 它们恰好是最难、最贵的那批。
 */

export type ComposeInput = {
  candidateId: string;
  sourceName: string;
  sourceUrl: string | null;
  title: string;
  body: string;
  section: string;
  mandatoryClass: string;
  /** 同事件其他来源的贡献，用于「合并后列出各渠道贡献」（PRD 7.4） */
  contributions: Array<{ sourceName: string; url: string | null }>;
  /** 必须融入摘要正文的限制说明（PRD 9.2） */
  sourceLimitations: string[];
  /** L2/L3 已产出的文案，有则直接复用 */
  precomposed?: { conclusion: string; summarySentences: string[] } | null;
};

export type ComposeOutcome = {
  candidateId: string;
  result: ComposeResult | null;
  status: 'ok' | 'reused' | 'manual_audit';
  error?: string;
  attempts: number;
};

export type ComposeDeps = {
  provider: Provider;
  systemPrompt: string;
  batchSize: number;
  bodyCharsMax: number;
  outputTokensMax: number;
  /** 邮件里禁止出现的字段名（PRD 9.2），生成后校验 */
  forbiddenFields?: string[];
  onUsage?: (u: CompleteResult['usage'], model: string) => void;
};

/**
 * 成品文案的硬性校验（PRD 9.2）。
 * 模型很容易自作主张加「建议」「行动建议」这类字段或段落 ——
 * PRD 明令禁止，必须在进入邮件前拦下。
 */
export function checkComposed(r: ComposeResult, forbidden: string[] = []): string[] {
  const errs: string[] = [];
  if (!r.conclusion?.trim()) errs.push('conclusion 为空');
  if (r.conclusion && r.conclusion.length > 120) errs.push(`conclusion 超过 120 字（${r.conclusion.length}）`);
  const n = r.summary_sentences?.length ?? 0;
  if (n < 2 || n > 3) errs.push(`summary_sentences 应为 2–3 句，实为 ${n}`);

  const blob = [r.title, r.conclusion, ...(r.summary_sentences ?? [])].join('\n');
  for (const f of forbidden) {
    // 匹配「建议：」「行动建议:」这类字段式写法，而非正文中偶然出现的词
    if (new RegExp(`(^|\\n)\\s*${escapeRe(f)}\\s*[:：]`).test(blob))
      errs.push(`输出含 PRD 9.2 禁止的字段「${f}」`);
  }
  return errs;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function runCompose(
  items: ComposeInput[], deps: ComposeDeps,
): Promise<{ outcomes: ComposeOutcome[]; usedInput: number; usedOutput: number; calls: number }> {
  const outcomes: ComposeOutcome[] = [];
  let usedInput = 0, usedOutput = 0, calls = 0;

  // 1. 复用 L2/L3 已产出的文案
  const pending: ComposeInput[] = [];
  for (const it of items) {
    if (it.precomposed?.conclusion && (it.precomposed.summarySentences?.length ?? 0) >= 2) {
      outcomes.push({
        candidateId: it.candidateId, status: 'reused', attempts: 0,
        result: {
          candidate_id: it.candidateId, title: it.title,
          conclusion: it.precomposed.conclusion,
          summary_sentences: it.precomposed.summarySentences.slice(0, 3),
          source_limitations: it.sourceLimitations,
        },
      });
    } else pending.push(it);
  }

  // 2. 其余分批生成
  for (let i = 0; i < pending.length; i += deps.batchSize) {
    const batch = pending.slice(i, i + deps.batchSize);
    outcomes.push(...await composeBatch(batch, deps, (u, m) => {
      usedInput += u.inputTokens; usedOutput += u.outputTokens; calls++; deps.onUsage?.(u, m);
    }));
  }
  return { outcomes, usedInput, usedOutput, calls };
}

async function composeBatch(
  batch: ComposeInput[], deps: ComposeDeps,
  track: (u: CompleteResult['usage'], m: string) => void,
): Promise<ComposeOutcome[]> {
  let attempts = 0, lastErr = '';

  for (const chars of [deps.bodyCharsMax, Math.floor(deps.bodyCharsMax / 3)]) {
    attempts++;
    const userContent = JSON.stringify({
      items: batch.map(b => ({
        candidate_id: b.candidateId,
        source: b.sourceName,
        url: b.sourceUrl,
        title: b.title,
        section: b.section,
        mandatory_class: b.mandatoryClass,
        must_disclose: b.sourceLimitations,
        other_sources: b.contributions.map(c => c.sourceName),
        body: b.body.slice(0, chars),
      })),
    });

    let res: CompleteResult;
    try {
      res = await deps.provider.complete({
        systemPrompt: deps.systemPrompt, userContent,
        schema: COMPOSE_SCHEMA, schemaName: 'compose',
        maxOutputTokens: Math.min(deps.outputTokensMax, Math.max(2000, batch.length * 1200)),
        cachePrefix: true,
      });
    } catch (e) {
      const pe = e as ProviderError;
      lastErr = `${pe.kind}: ${pe.message}`;
      if (pe instanceof ProviderError && !pe.retryable && pe.kind !== 'bad_request') break;
      continue;
    }
    track(res.usage, res.model);

    const errs = validate(res.data, COMPOSE_SCHEMA);
    if (errs.length) { lastErr = `Schema 校验失败: ${errs.slice(0, 3).join('; ')}`; continue; }

    const byId = new Map<string, ComposeResult>(
      (res.data as any).results.map((r: ComposeResult) => [r.candidate_id, r]));
    const missing = batch.filter(b => !byId.has(b.candidateId));
    if (missing.length) { lastErr = `模型漏写 ${missing.length} 条文案`; continue; }

    // PRD 9.2 字段禁令校验
    const bad: string[] = [];
    for (const b of batch) {
      const e = checkComposed(byId.get(b.candidateId)!, deps.forbiddenFields);
      if (e.length) bad.push(`${b.candidateId}: ${e.join('; ')}`);
    }
    if (bad.length) { lastErr = bad.slice(0, 2).join(' | '); continue; }

    return batch.map(b => ({
      candidateId: b.candidateId, result: byId.get(b.candidateId)!, status: 'ok' as const, attempts,
    }));
  }

  return batch.map(b => ({
    candidateId: b.candidateId, result: null, status: 'manual_audit' as const, attempts, error: lastErr,
  }));
}
