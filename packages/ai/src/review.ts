import type { Provider, CompleteResult, JsonSchema } from './types.ts';
import { ProviderError } from './types.ts';
import { validate } from './schema.ts';
import type { Candidate } from './triage.ts';

/**
 * L2/L3 复核编排器（PRD 15.1 / 15.4）。
 *
 * 与 L1 的三点不同：
 *  1. 逐条处理，不分批 —— 这些是难case，且预算按「最多 N 条」限制。
 *  2. 名额有限时必须按重要性排序，不能先到先得（PRD 15.5：超预算时
 *     继续完成强制保留和高风险项，普通低分候选延迟到人工审阅）。
 *  3. L3 失败不再升级，直接转人工（PRD 15.1 表格 l3_on_failure）。
 */

export const REVIEW_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['candidate_id', 'decision', 'mandatory_class', 'section', 'event_key',
             'confidence', 'filter_reason', 'conflicts', 'source_limitations',
             'needs_higher_tier', 'higher_tier_reasons'],
  properties: {
    candidate_id: { type: 'string' },
    decision: { type: 'string', enum: ['retain', 'normal', 'filter'] },
    mandatory_class: { type: 'string', enum: ['A', 'B', 'C', 'D', 'none'] },
    section: { type: 'string',
      enum: ['ai_tech', 'developer_product', 'quality_article', 'society_life'] },
    event_key: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    filter_reason: { type: ['string', 'null'] },
    /** 发现的事实冲突。空数组表示未发现冲突。 */
    conflicts: { type: 'array', items: { type: 'string' } },
    /** 来源限制说明，后续必须融入摘要正文（PRD 9.2） */
    source_limitations: { type: 'array', items: { type: 'string' } },
    /** L2 判断是否仍需 L3。L3 层此字段被忽略。 */
    needs_higher_tier: { type: 'boolean' },
    higher_tier_reasons: { type: 'array', items: { type: 'string' } },
    /** 复核层顺带产出的成品文案，可供 compose 复用，避免重复调用 */
    conclusion: { type: ['string', 'null'], maxLength: 120 },
    summary_sentences: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 3 },
  },
};

export type ReviewResult = {
  candidate_id: string;
  decision: 'retain' | 'normal' | 'filter';
  mandatory_class: 'A' | 'B' | 'C' | 'D' | 'none';
  section: string;
  event_key: string;
  confidence: number;
  filter_reason: string | null;
  conflicts: string[];
  source_limitations: string[];
  needs_higher_tier: boolean;
  higher_tier_reasons: string[];
  conclusion?: string | null;
  summary_sentences?: string[] | null;
};

export type ReviewInput = Candidate & {
  /** L1 的判定结果，作为复核的起点 */
  priorDecision: string;
  priorConfidence: number;
  /** 触发升级的规则 */
  escalationRules: string[];
  /** 同事件的其他来源条目，供交叉核验（PRD 15.1 L2「多来源合并」） */
  siblings?: Array<{ sourceId: string; title: string; excerpt: string; url: string | null }>;
};

export type ReviewOutcome = {
  candidateId: string;
  tier: 'L2' | 'L3';
  result: ReviewResult | null;
  status: 'ok' | 'manual_audit' | 'skipped';
  /** L2 之后是否还要送 L3 */
  promote: boolean;
  promoteRules: string[];
  error?: string;
  attempts: number;
  responseId?: string;
};

export type TierBudget = { maxItems: number; inputTokensMax: number; outputTokensMax: number };

export type ReviewDeps = {
  l2: { provider: Provider; budget: TierBudget };
  l3: { provider: Provider; budget: TierBudget };
  systemPrompt: string;
  bodyCharsMax: number;
  /** 高风险关键词，用于 ESC-102 与优先级排序 */
  highRiskKeywords?: string[];
  /** 带守卫的高风险判定；未提供时退回裸关键词匹配 */
  isHighRisk?: (text: string) => boolean;
  onUsage?: (tier: 'L2' | 'L3', u: CompleteResult['usage'], model: string) => void;
};

export type ReviewReport = {
  outcomes: ReviewOutcome[];
  l2Used: { items: number; input: number; output: number };
  l3Used: { items: number; input: number; output: number };
  /** 因名额不足未能复核，转人工审阅的候选 */
  deferred: string[];
};

const estTokens = (s: string) => Math.ceil(s.length / 2.2);

/**
 * 名额有限时的优先级（PRD 15.5）。数字越小越优先。
 *
 * ESC-005 排在最前是刻意的：强制保留预判命中、模型却判为过滤，
 * 这是唯一可能造成「该收录却漏掉」的情形，而漏项是本系统最难
 * 事后发现的失败（PRD 24.1 要求召回率 ≥98%）。宁可挤掉低置信条目。
 */
export function priorityOf(
  c: ReviewInput, highRisk: string[] = [], isHighRisk?: (t: string) => boolean,
): number {
  if (c.escalationRules.includes('ESC-005')) return 0;   // 可能漏掉强制保留项
  if (c.prescreenClasses.length > 0) return 1;           // 其他强制保留候选
  const hay = `${c.title}\n${c.body}`;
  const risky = isHighRisk ? isHighRisk(hay) : highRisk.some(k => hay.includes(k));
  if (risky) return 2;                                   // 高风险领域
  if (c.escalationRules.includes('ESC-003')) return 3;   // 重大新闻
  if (c.escalationRules.includes('ESC-004')) return 4;   // 来源冲突
  return 5;                                              // 低置信等
}

/** L2 → L3 升级判定（rules.yaml escalation.l2_to_l3）。 */
export function shouldPromoteToL3(
  c: ReviewInput, r: ReviewResult, highRisk: string[] = [],
  isHighRisk?: (t: string) => boolean,
): { promote: boolean; rules: string[] } {
  const rules: string[] = [];
  if (r.conflicts.length > 0) rules.push('ESC-101');      // 复核后仍存冲突
  const hay = `${c.title}\n${c.body}`;
  const hasNumbers = /\d+(\.\d+)?\s*(%|％|倍|万|亿|美元|元|人|例)/.test(hay);
  const risky = isHighRisk ? isHighRisk(hay) : highRisk.some(k => hay.includes(k));
  if (risky && hasNumbers) rules.push('ESC-102');
  if (r.needs_higher_tier) rules.push('ESC-103');
  return { promote: rules.length > 0, rules: [...new Set(rules)] };
}

function buildUserContent(c: ReviewInput, bodyChars: number): string {
  return JSON.stringify({
    candidate_id: c.candidateId,
    source: c.sourceId,
    title: c.title,
    published_at: c.publishedAt,
    url: c.url,
    extracted: { repos: c.repos.slice(0, 5), official_links: c.officialLinks.slice(0, 5), signals: c.signals },
    rule_prescreen: { mandatory_classes: c.prescreenClasses },
    l1_result: { decision: c.priorDecision, confidence: c.priorConfidence },
    escalation_rules: c.escalationRules,
    siblings: (c.siblings ?? []).slice(0, 4),
    body: c.body.slice(0, bodyChars),
  });
}

async function reviewOne(
  c: ReviewInput, tier: 'L2' | 'L3', deps: ReviewDeps,
  track: (u: CompleteResult['usage'], m: string) => void,
): Promise<ReviewOutcome> {
  const { provider, budget } = tier === 'L2' ? deps.l2 : deps.l3;
  let attempts = 0, lastErr = '';
  let lastKind: string | undefined;
  let outCap = Math.min(budget.outputTokensMax, tier === 'L3' ? 8000 : 6000);

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    const chars = attempt === 0 || lastKind === 'truncated'
      ? deps.bodyCharsMax : Math.floor(deps.bodyCharsMax / 3);
    if (lastKind === 'truncated') outCap = Math.min(budget.outputTokensMax, outCap * 2);
    let res: CompleteResult;
    try {
      res = await provider.complete({
        systemPrompt: deps.systemPrompt + `\n\n当前复核层级：${tier}。`,
        userContent: buildUserContent(c, chars),
        schema: REVIEW_SCHEMA,
        schemaName: 'review',
        maxOutputTokens: outCap,
        cachePrefix: true,
      });
    } catch (e) {
      const pe = e as ProviderError;
      lastErr = `${pe.kind}: ${pe.message}`;
      lastKind = pe instanceof ProviderError ? pe.kind : undefined;
      if (pe instanceof ProviderError && !pe.retryable && pe.kind !== 'bad_request') break;
      continue;
    }
    track(res.usage, res.model);

    const errs = validate(res.data, REVIEW_SCHEMA);
    if (errs.length) { lastErr = `Schema 校验失败: ${errs.slice(0, 3).join('; ')}`; lastKind = 'schema'; continue; }

    const r = res.data as ReviewResult;
    if (r.candidate_id !== c.candidateId) {
      lastErr = `candidate_id 不匹配：期望 ${c.candidateId} 实得 ${r.candidate_id}`;
      lastKind = 'schema';
      continue;
    }
    // L2 才判断是否上 L3；L3 之后不再升级（PRD 15.1）
    const p = tier === 'L2'
      ? shouldPromoteToL3(c, r, deps.highRiskKeywords, deps.isHighRisk)
      : { promote: false, rules: [] };
    return { candidateId: c.candidateId, tier, result: r, status: 'ok',
             promote: p.promote, promoteRules: p.rules, attempts, responseId: res.responseId };
  }

  return { candidateId: c.candidateId, tier, result: null, status: 'manual_audit',
           promote: false, promoteRules: [], attempts, error: lastErr };
}

export async function runReview(inputs: ReviewInput[], deps: ReviewDeps): Promise<ReviewReport> {
  const outcomes: ReviewOutcome[] = [];
  const l2Used = { items: 0, input: 0, output: 0 };
  const l3Used = { items: 0, input: 0, output: 0 };
  const deferred: string[] = [];

  const queue = [...inputs].sort((a, b) =>
    priorityOf(a, deps.highRiskKeywords, deps.isHighRisk) -
    priorityOf(b, deps.highRiskKeywords, deps.isHighRisk));

  const promoted: ReviewInput[] = [];
  for (const c of queue) {
    const est = estTokens(deps.systemPrompt) + estTokens(buildUserContent(c, deps.bodyCharsMax));
    if (l2Used.items >= deps.l2.budget.maxItems ||
        l2Used.input + est > deps.l2.budget.inputTokensMax ||
        l2Used.output >= deps.l2.budget.outputTokensMax) {
      deferred.push(c.candidateId);
      outcomes.push({ candidateId: c.candidateId, tier: 'L2', result: null, status: 'skipped',
                      promote: false, promoteRules: [], attempts: 0,
                      error: 'L2 名额/预算已用尽，转人工审阅' });
      continue;
    }
    const o = await reviewOne(c, 'L2', deps, (u, m) => {
      l2Used.input += u.inputTokens; l2Used.output += u.outputTokens; deps.onUsage?.('L2', u, m);
    });
    l2Used.items++;
    outcomes.push(o);
    if (o.promote) promoted.push(c);
  }

  for (const c of promoted) {
    const est = estTokens(deps.systemPrompt) + estTokens(buildUserContent(c, deps.bodyCharsMax));
    if (l3Used.items >= deps.l3.budget.maxItems ||
        l3Used.input + est > deps.l3.budget.inputTokensMax ||
        l3Used.output >= deps.l3.budget.outputTokensMax) {
      deferred.push(c.candidateId);
      outcomes.push({ candidateId: c.candidateId, tier: 'L3', result: null, status: 'skipped',
                      promote: false, promoteRules: [], attempts: 0,
                      error: 'L3 名额/预算已用尽，保留 L2 判定并转人工复核' });
      continue;
    }
    const o = await reviewOne(c, 'L3', deps, (u, m) => {
      l3Used.input += u.inputTokens; l3Used.output += u.outputTokens; deps.onUsage?.('L3', u, m);
    });
    l3Used.items++;
    outcomes.push(o);
  }

  return { outcomes, l2Used, l3Used, deferred };
}
