/**
 * 「技术教程」板块：只从 LINUX DO / V2EX 挑「步骤完整、可复现」的技术帖。
 * 确定性部分（预筛、去重、相似合并）不调用模型、不读写数据库；模型判定在 ai.ts（judgeTutorials）。
 * 不增加任何站点请求：只使用库里已存的正文/摘要（fulltext_text 或 clean_text）。
 */
import type { Provider } from '../../ai/src/types.ts';
import { extractSignals, prescreenMandatory } from '../../domain/src/signals.ts';
import { classifyRepost, extractRepos, similarity, urlKey, type DigestSourceItem, type DigestTutorial } from './core.ts';
import { judgeReposts, judgeTutorials } from './ai.ts';

export const TUTORIAL_SOURCES = ['linuxdo', 'v2ex'];
/** 与 rules.yaml mandatory_retention B 类 topic_scope 一致，另补常见表述。命中即进入模型判定。 */
export const TUTORIAL_KEYWORDS = ['教程', '配置', '部署', '架构', '复盘', '实测', '踩坑', '排障', '排查', '优化', '迁移', '对比测试',
  '搭建', '安装', '折腾', '逆向', '命令', '脚本', '解决方案', '方法', '步骤', '指南', '攻略', '自建', '自托管', 'docker', 'nginx', 'ssh'];
const MIN_BODY = 60;      // 少于此字数不可能含步骤
const LONG_BODY = 400;    // 足够长的帖子即使没有关键词也交给模型看

export type TutorialExcluded = { id: number; sourceId: string; title: string; url: string | null; reason: string; stage: 'prescreen' | 'repost' | 'project' | 'history' | 'model' | 'dup' };
export type TutorialReport = {
  candidates: Record<string, number>;   // 各来源候选帖总数
  sentToModel: number;
  picked: number;
  excluded: TutorialExcluded[];
  modelError?: string;
};

const hostOf = (u: string | null) => { try { return u ? new URL(u).hostname.toLowerCase().replace(/^www\./, '') : ''; } catch { return ''; } };

/** 确定性预筛：返回 null 表示通过，否则返回排除原因。signals 供模型参考。 */
export function prescreenTutorial(it: DigestSourceItem): { reason: string | null; signals: string[] } {
  const body = it.text.replace(/\s+/g, ' ').trim();
  const sig = extractSignals(it.text, '', hostOf(it.url));
  const hit = Object.entries(sig.signals).filter(([, v]) => v).map(([k]) => k);
  if (body.length < MIN_BODY) return { reason: '内容过短，无可复现步骤', signals: hit };
  if (sig.signals.aff_link && !sig.signals.code_block && !sig.signals.command_line && !sig.signals.config_block)
    return { reason: '含 AFF/推广链接，疑似营销', signals: hit };
  const lower = `${it.title}\n${body}`.toLowerCase();
  const hasB = prescreenMandatory(sig.signals).includes('B');
  const hasKw = TUTORIAL_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
  if (!hasB && !hasKw && !sig.signals.step_markers && !sig.signals.install_hint && body.length < LONG_BODY)
    return { reason: '预筛：无代码/命令/配置/步骤特征，也无教程类关键词', signals: hit };
  return { reason: null, signals: hit };
}

/** 去掉概括里可能残留的星标、来源名前缀。 */
export function cleanTutorialSummary(s: string): string {
  let t = s.replace(/[⭐🌟★☆*]/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:在\s*)?(?:LINUX\s*DO|linux\.do|V2EX|L站|V站)(?:\s*论坛)?\s*(?:上|里|中)?\s*[:：,，]?\s*/i, '');
  return t.trim();
}

export type TutorialCtx = {
  officials: DigestSourceItem[];        // 近 72h 官方条目，用于转载比对
  projectRepos: Set<string>;            // 本期「开源项目」板块已入选仓库
  pushedUrls: Set<string>;              // 72h 已推送教程 URL key
  pushedTitles: string[];               // 72h 已推送教程标题
};

export async function buildTutorials(provider: Provider, items: DigestSourceItem[], ctx: TutorialCtx):
  Promise<{ tutorials: DigestTutorial[]; report: TutorialReport; log: string[] }> {
  const log: string[] = [];
  const cands = items.filter(i => TUTORIAL_SOURCES.includes(i.sourceId) && !i.official);
  const report: TutorialReport = { candidates: {}, sentToModel: 0, picked: 0, excluded: [] };
  for (const c of cands) report.candidates[c.sourceId] = (report.candidates[c.sourceId] ?? 0) + 1;
  const exclude = (i: DigestSourceItem, reason: string, stage: TutorialExcluded['stage']) =>
    report.excluded.push({ id: i.id, sourceId: i.sourceId, title: i.title, url: i.url, reason, stage });

  // 1. 确定性预筛 + 72h 去重 + 已在开源项目板块
  const pass: Array<{ it: DigestSourceItem; signals: string[] }> = [];
  for (const it of cands) {
    const k = urlKey(it.url);
    if (k && ctx.pushedUrls.has(k)) { exclude(it, '72 小时内已推送过', 'history'); continue; }
    if (ctx.pushedTitles.some(t => similarity(t, it.title) >= 0.6)) { exclude(it, '与 72 小时内已推送教程重复', 'history'); continue; }
    const repos = extractRepos(`${it.url ?? ''}\n${it.title}\n${it.text}`);
    const dup = repos.find(r => ctx.projectRepos.has(r));
    if (dup) { exclude(it, `仓库 ${dup} 已在「开源项目」板块`, 'project'); continue; }
    // 交叉发布：与已因「开源项目」板块排除的帖子标题高度相似（同一内容的另一站副本）
    const twin = report.excluded.find(x => x.stage === 'project' && similarity(x.title, it.title) >= 0.6);
    if (twin) { exclude(it, `同一内容的交叉发布，仓库已在「开源项目」板块：${twin.title.slice(0, 20)}`, 'project'); continue; }
    const p = prescreenTutorial(it);
    if (p.reason) { exclude(it, p.reason, 'prescreen'); continue; }
    pass.push({ it, signals: p.signals });
  }

  // 2. 与官方厂商新闻重复的转载（沿用 classifyRepost）
  const reposts = new Set<number>(); const uncertain: Array<{ id: number; item: DigestSourceItem; official: DigestSourceItem }> = [];
  for (const { it } of pass) {
    const c = classifyRepost(it, ctx.officials);
    if (c.verdict === 'repost') reposts.add(it.id);
    else if (c.verdict === 'uncertain' && uncertain.length < 20) uncertain.push({ id: it.id, item: it, official: ctx.officials.find(o => o.id === c.officialId)! });
  }
  for (const [id, yes] of await judgeReposts(provider, uncertain)) if (yes) reposts.add(id);
  const afterRepost = pass.filter(({ it }) => { if (reposts.has(it.id)) { exclude(it, '转载/改写官方厂商新闻，已有官方动态覆盖', 'repost'); return false; } return true; });

  // 3. 模型判定 + 概括
  report.sentToModel = afterRepost.length;
  const { results, error } = await judgeTutorials(provider, afterRepost.map(({ it, signals }) => ({ id: it.id, title: it.title, text: it.text, signals })));
  if (error) { report.modelError = error; log.push(`  ⚠️ 技术教程模型判定失败（部分或全部）：${error}`); }
  const picked: DigestTutorial[] = [];
  for (const { it } of afterRepost) {
    const r = results.get(it.id);
    if (!r) { exclude(it, '模型未返回判定（保守不收录）', 'model'); continue; }
    const summary = cleanTutorialSummary(r.summary);
    if (!r.tutorial || !summary) { exclude(it, r.reason || '模型判定不是可复现教程', 'model'); continue; }
    if (!it.url) { exclude(it, '无原帖链接', 'model'); continue; }
    // V2EX 与 LINUX DO 交叉发布同一内容：只保留先到的一条
    const same = picked.find(p => similarity(p.title, it.title) >= 0.6 || similarity(p.summary, summary) >= 0.6);
    if (same) { exclude(it, `与已入选条目重复（交叉发布）：${same.title.slice(0, 20)}`, 'dup'); continue; }
    picked.push({ title: it.title, summary, url: it.url, itemId: it.id });
  }
  report.picked = picked.length;
  const total = cands.length;
  log.push(`技术教程候选 ${total} 条（${Object.entries(report.candidates).map(([k, v]) => `${k} ${v}`).join('、') || '0'}），送模型 ${report.sentToModel} 条，入选 ${picked.length} 条`);
  for (const x of report.excluded) log.push(`  技术教程排除[${x.stage}] ${x.sourceId} ${x.title.slice(0, 40)} —— ${x.reason}`);
  return { tutorials: picked, report, log };
}
