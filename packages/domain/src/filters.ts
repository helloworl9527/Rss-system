import { loadRules, re } from './rules.ts';
import type { SignalMap } from './signals.ts';

export type FilterCtx = {
  title: string;
  cleanText: string;
  signals: SignalMap;
  externalLinkCount: number;
  /** 命中强制保留预判（A–D 任一）。决定 normal_only 规则是否适用。 */
  isMandatory: boolean;
  /** 同 canonical key 已发送且语义指纹未变（PRD 7.3）。 */
  alreadySentNoUpdate: boolean;
  /** 去掉追踪参数后与库中已有条目 canonical_url 相同。 */
  duplicateCanonical: boolean;
};

export type FilterHit = { ruleId: string; name: string; reason: string; alert?: boolean };

/**
 * 确定性过滤（rules.yaml deterministic_filters）。命中即返回，不调用 AI。
 *
 * 两条硬约束：
 *  1. applies_to=normal_only 的规则不得淘汰强制保留候选 —— 那些候选
 *     只能由 AI 语义判定或人工覆盖排除（PRD 8.2）。
 *  2. 返回的 reason 必须能通过 never_filter_on 校验，否则视为规则退化，
 *     抛错转人工而不是静默过滤（PRD 8.3 末段）。
 */
export function applyDeterministicFilters(ctx: FilterCtx): FilterHit | null {
  const R = loadRules();
  const S = ctx.signals;
  const len = ctx.cleanText.trim().length;

  const rules: Array<FilterHit & { when: () => boolean; scope: 'all' | 'normal_only' }> = [
    { ruleId: 'DF-001', name: 'already_sent_no_update', scope: 'all',
      reason: '同一条目已发送且无实质更新',
      when: () => ctx.alreadySentNoUpdate },

    { ruleId: 'DF-002', name: 'empty_title_or_body', scope: 'all',
      reason: '标题或正文为空',
      when: () => ctx.title.trim().length < 2 || len < 10 },

    { ruleId: 'DF-003', name: 'duplicate_by_tracking_params', scope: 'all',
      reason: '去除追踪参数后与已有条目重复',
      when: () => ctx.duplicateCanonical },

    { ruleId: 'DF-021', name: 'unknown_credential_leak', scope: 'all', alert: true,
      reason: '正文包含疑似泄露的密钥或访问令牌',
      when: () => {
        const d = R.deterministic_filters.find((f: any) => f.id === 'DF-021');
        return (d?.condition?.any_of ?? []).some((p: any) => re(p).test(ctx.cleanText));
      } },

    { ruleId: 'DF-010', name: 'aff_recruitment', scope: 'normal_only',
      reason: '联盟推广拉新且无可操作内容',
      when: () => !!S.aff_link && !S.code_block && !S.step_markers },

    { ruleId: 'DF-011', name: 'coupon_without_content', scope: 'normal_only',
      reason: '仅有优惠码而无操作步骤',
      when: () => !!S.invite_code && !S.step_markers && len < 200 },

    { ruleId: 'DF-020', name: 'low_information_chat', scope: 'normal_only',
      reason: '低信息量：无链接、无代码、无步骤且篇幅极短',
      when: () => len < 120 && !S.repo_url && !S.code_block && !S.command_line
                  && !S.step_markers && ctx.externalLinkCount < 1 },
  ];

  for (const r of rules) {
    if (r.scope === 'normal_only' && ctx.isMandatory) continue;
    if (!r.when()) continue;
    assertReasonAllowed(r.reason, r.ruleId);
    return { ruleId: r.ruleId, name: r.name, reason: r.reason, alert: r.alert };
  }
  return null;
}

/**
 * 反向保护：过滤理由不得落在 never_filter_on 上（PRD 8.3 末段）。
 * 命中即抛错转人工审计 —— 这是防止规则悄悄退化成「按热度/商业属性过滤」的闸门。
 */
export function assertReasonAllowed(reason: string, ruleId = ''): void {
  const banned: string[] = loadRules().never_filter_on ?? [];
  const hit = banned.find(b => reason.includes(b));
  if (hit)
    throw new Error(
      `过滤理由命中反向保护清单「${hit}」（规则 ${ruleId}，理由「${reason}」）。` +
      `PRD 8.3 明令这类理由不得单独作为过滤依据，应转人工审计。`);
}
