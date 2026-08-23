#!/usr/bin/env node
/**
 * 简报组装与投递（PRD 9 / 12.1 后半段）。
 *
 *   node apps/worker/src/brief.ts --run 3            组装并按配置投递
 *   node apps/worker/src/brief.ts --run 3 --no-send  只组装与预览，不投递
 *   node apps/worker/src/brief.ts --run 3 --shadow   影子投递（带 X-Brief-Environment）
 *
 * 组装是幂等的：同一 run 已有 final 简报时不重复生成，
 * 投递由 deliveries 唯一键兜底，重跑不会重复发送（PRD 12.3 / 24.1-P0）。
 */
import { readFileSync } from 'node:fs';
import { openDb, nowIso, type DB } from '../../../packages/db/src/index.ts';
import { loadRules } from '../../../packages/domain/src/rules.ts';
import { windowFromKey } from '../../../packages/domain/src/normalize.ts';
import { clusterCandidates, selectForBrief, type ClusterInput }
  from '../../../packages/domain/src/cluster.ts';
import { createProvider, providerFromEnv } from '../../../packages/ai/src/registry.ts';
import { runCompose, type ComposeInput } from '../../../packages/ai/src/compose.ts';
import { renderHtml, renderText, checkEmail, subjectOf, type BriefData, type BriefItem }
  from '../../../packages/templates/src/email.ts';
import { deliver } from '../../../packages/templates/src/delivery.ts';
import { mailerFromEnv } from '../../../packages/templates/src/mailer.ts';

const argv = process.argv.slice(2);
const NO_SEND = argv.includes('--no-send');
const SHADOW = argv.includes('--shadow');
const runArg = argv.includes('--run') ? Number(argv[argv.indexOf('--run') + 1]) : null;

const db: DB = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
const rules = loadRules();
const OUT_DIR = process.env.MAIL_OUT_DIR ?? './data/outbox';

const run = (runArg
  ? db.prepare('SELECT * FROM runs WHERE id=?').get(runArg)
  : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get()) as any;
if (!run) { console.log('没有可用的 run'); db.close(); process.exit(0); }

const win = windowFromKey(run.window_key);
const fmt = (d: Date) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

// ---------- 1. 取候选与判定 ----------
type Row = {
  cid: number; vid: number; source_id: string; category: string; priority: number;
  title: string; body: string; url: string | null; published_at: string | null;
  decision: string; mandatory_class: string | null; section: string | null;
  late_discovery: number; origin_window_key: string; first_seen_at: string;
  signals_json: string | null; filter_rule_id: string | null; filter_reason: string | null;
  is_official: number; result_json: string | null;
};
const rows = db.prepare(`
  SELECT c.id cid, c.item_version_id vid, f.source_id, s.category, s.priority,
         v.title, coalesce(v.fulltext_text, v.clean_text) body,
         f.canonical_url url, f.published_at, c.decision, c.mandatory_class, c.section,
         c.late_discovery, c.origin_window_key, f.first_seen_at,
         v.signals_json, c.filter_rule_id, c.filter_reason,
         (json_extract(s.config_json,'$.official') IS NOT NULL) is_official,
         (SELECT e.result_json FROM evaluations e WHERE e.candidate_id=c.id
           ORDER BY CASE e.stage WHEN 'sol' THEN 0 WHEN 'terra' THEN 1 ELSE 2 END, e.id DESC LIMIT 1) result_json
  FROM candidates c
  JOIN item_versions v ON v.id=c.item_version_id
  JOIN feed_items f ON f.id=v.item_id
  JOIN sources s ON s.id=f.source_id
  WHERE c.run_id=?`).all(run.id) as Row[];

if (!rows.length) { console.log(`run #${run.id} 没有候选`); db.close(); process.exit(0); }

const included = rows.filter(r => r.decision === 'retain' || r.decision === 'normal');
const parseEval = (r: Row) => { try { return r.result_json ? JSON.parse(r.result_json) : null; } catch { return null; } };

// ---------- 2. 聚类与排序 ----------
const inputs: ClusterInput[] = included.map(r => {
  const e = parseEval(r);
  const sig = r.signals_json ? JSON.parse(r.signals_json) as Record<string, boolean> : {};
  return {
    candidateId: `c${r.cid}`, sourceId: r.source_id, title: r.title, url: r.url,
    publishedAt: r.published_at,
    eventKey: e?.event_key ?? `solo-${r.cid}`,
    section: r.section ?? e?.section ?? 'ai_tech',
    decision: r.decision, mandatoryClass: r.mandatory_class ?? 'none',
    confidence: e?.confidence ?? 0.5,
    importance: e?.importance ?? 0.5, novelty: e?.novelty ?? 0.5,
    signals: Object.entries(sig).filter(([, v]) => v).map(([k]) => k),
    sourcePriority: r.priority ?? 5, isOfficial: !!r.is_official,
  };
});
const clusters = clusterCandidates(inputs);
const { selected, dropped } = selectForBrief(clusters);

console.log(`run #${run.id} ${run.window_key} ${run.window_label}`);
console.log(`候选 ${rows.length} → 入选候选 ${included.length} → 聚类 ${clusters.length} → 选中 ${selected.length}`);

if (!selected.length) {
  // PRD 9.1：合格内容不足时允许少于 5 条，禁止用旧消息凑数 —— 一条不够也如实反映
  console.log('本窗口没有达标内容。按 PRD 9.1，不用旧消息凑数。');
}

// ---------- 3. 生成文案 ----------
const byCid = new Map(rows.map(r => [`c${r.cid}`, r]));
const composeInputs: ComposeInput[] = selected.map(c => {
  const r = byCid.get(c.primary.candidateId)!;
  const e = parseEval(r);
  return {
    candidateId: c.primary.candidateId,
    sourceName: r.source_id, sourceUrl: r.url, title: r.title, body: r.body,
    section: c.section, mandatoryClass: c.mandatoryClass,
    contributions: c.members.map(m => ({ sourceName: m.sourceId, url: m.url })),
    sourceLimitations: e?.source_limitations ?? [],
    precomposed: e?.conclusion && e?.summary_sentences?.length >= 2
      ? { conclusion: e.conclusion, summarySentences: e.summary_sentences } : null,
  };
});

const cfg = providerFromEnv('L1');
const provider = await createProvider(cfg);
const composed = composeInputs.length
  ? await runCompose(composeInputs, {
      provider, systemPrompt: readFileSync('./config/prompts/compose.md', 'utf8'),
      batchSize: 4, bodyCharsMax: 4000,
      outputTokensMax: rules.ai?.budget_per_run?.luna?.output_tokens_max ?? 8000,
      forbiddenFields: rules.brief?.item_fields_forbidden ?? [],
    })
  : { outcomes: [], usedInput: 0, usedOutput: 0, calls: 0 };

const copy = new Map(composed.outcomes.filter(o => o.result).map(o => [o.candidateId, o.result!]));
const composeFailed = composed.outcomes.filter(o => !o.result);
if (composed.calls)
  console.log(`文案：调用 ${composed.calls} 次，输入 ${composed.usedInput} / 输出 ${composed.usedOutput} token` +
              `，复用 ${composed.outcomes.filter(o => o.status === 'reused').length} 条`);
if (composeFailed.length) console.log(`⚠️  ${composeFailed.length} 条文案生成失败，已从简报中剔除并转人工`);

// ---------- 4. 组装 BriefData ----------
const SECTIONS = rules.brief?.sections ?? [];
const sectionTitle = (id: string) =>
  SECTIONS.find((s: any) => s.id === id)?.title ?? id;

const items: Array<BriefItem & { section: string; score: number }> = [];
for (const c of selected) {
  const r = byCid.get(c.primary.candidateId)!;
  const cp = copy.get(c.primary.candidateId);
  if (!cp) continue;                                     // 文案失败的不进简报
  items.push({
    section: c.section, score: c.score,
    title: cp.title || r.title,
    conclusion: cp.conclusion,
    summarySentences: cp.summary_sentences,
    sourceName: r.source_id,
    sourceUrl: r.url,
    otherSources: c.members.map(m => m.sourceId),
    lateDiscovery: r.late_discovery ? {
      originWindow: r.origin_window_key,
      publishedAt: String(r.published_at ?? '').slice(0, 16).replace('T', ' '),
      firstSeenAt: String(r.first_seen_at).slice(0, 16).replace('T', ' '),
    } : null,
  });
}

// 核心要点：按分数取前 N 条的结论（PRD 9.1，不足时允许少于 5 条）
const [hMin, hMax] = rules.brief?.sections?.[0]?.count ?? [5, 8];
void hMin;
const highlights = [...items].sort((a, b) => b.score - a.score)
  .slice(0, hMax).map(i => i.conclusion);

// 审计区（PRD 9.3）
const filtered = rows.filter(r => r.decision === 'filter');
const byRule: Record<string, number> = {};
for (const f of filtered) byRule[f.filter_rule_id ?? '其他'] = (byRule[f.filter_rule_id ?? '其他'] ?? 0) + 1;

const mandatoryMisses = rows
  .filter(r => r.decision === 'filter' && r.mandatory_class && r.mandatory_class !== 'none')
  .map(r => ({ title: r.title, url: r.url, reason: r.filter_reason ?? r.filter_rule_id ?? '未记录原因' }));

const sourceIssues = (db.prepare(`SELECT id, health, last_error, consecutive_failures
  FROM sources WHERE enabled=1 AND health IN ('failing','degraded')`).all() as any[])
  .map(s => ({ source: s.id,
               status: s.health === 'failing' ? '抓取失败' : '来源异常',
               detail: `${String(s.last_error ?? '').slice(0, 80)}（连续 ${s.consecutive_failures} 次）` }));

const data: BriefData = {
  date: run.window_key.slice(0, 10),
  windowLabel: run.window_label,
  windowRange: `${fmt(win.start)}–${fmt(win.end)}`,
  highlights,
  sections: (SECTIONS.filter((s: any) => s.id !== 'core_highlights' && s.id !== 'audit'))
    .map((s: any) => ({ id: s.id, title: s.title,
      items: items.filter(i => i.section === s.id).sort((a, b) => b.score - a.score) })),
  audit: {
    mandatoryMisses,
    counts: [
      { label: '正常入选', count: items.length },
      { label: '补录', count: items.filter(i => i.lateDiscovery).length },
      { label: '已过滤', count: filtered.length },
      ...Object.entries(byRule).map(([k, v]) => ({ label: k, count: v })),
      { label: '未入选（分数不足）', count: dropped.length },
    ].filter(c => c.count > 0),
    sourceIssues,
  },
};

// ---------- 5. 渲染与校验 ----------
const html = renderHtml(data), text = renderText(data), subject = subjectOf(data);
const errs = checkEmail(html, text);
if (errs.length) {
  console.error('❌ 邮件校验未通过，拒绝发送：');
  errs.forEach(e => console.error('   ' + e));
  db.close(); process.exit(1);
}
console.log(`简报：${items.length} 条 / ${Math.round(Buffer.byteLength(html, 'utf8') / 1024)} KB / 主题「${subject}」`);
if (sectionTitle('audit')) { /* 分区标题已由 rules 提供 */ }

// ---------- 6. 持久化不可变版本（FR-052） ----------
const existing = db.prepare(
  `SELECT id, version FROM briefs WHERE run_id=? ORDER BY version DESC LIMIT 1`).get(run.id) as any;
const version = (existing?.version ?? 0) + 1;
let briefId: number;

if (existing && !argv.includes('--regenerate')) {
  briefId = existing.id;
  console.log(`已存在简报 #${briefId}（v${existing.version}），复用；加 --regenerate 可生成新版本`);
} else {
  briefId = Number(db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO briefs (run_id,version,subject,text_body,html_body,
      html_bytes,status,rule_version,created_at) VALUES (?,?,?,?,?,?,'final',?,?)`)
      .run(run.id, version, subject, text, html, Buffer.byteLength(html, 'utf8'),
           rules.meta.rule_version, nowIso()).lastInsertRowid);
    if (existing) db.prepare(`UPDATE briefs SET status='superseded' WHERE id=?`).run(existing.id);

    const insCluster = db.prepare(`INSERT INTO story_clusters (cluster_key,canonical_title,
      current_version_hash,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(cluster_key) DO UPDATE SET canonical_title=excluded.canonical_title,
      updated_at=excluded.updated_at`);
    const getCluster = db.prepare('SELECT id FROM story_clusters WHERE cluster_key=?');
    const insMember = db.prepare(`INSERT INTO cluster_members (cluster_id,item_version_id,
      contribution,added_by,created_at) VALUES (?,?,?,'model',?)
      ON CONFLICT(cluster_id,item_version_id) DO NOTHING`);
    const insItem = db.prepare(`INSERT INTO brief_items (brief_id,story_cluster_id,version_hash,
      section,order_no,status,title,conclusion,summary_json,source_name,source_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

    let order = 0;
    for (const c of selected) {
      const cp = copy.get(c.primary.candidateId); if (!cp) continue;
      const r = byCid.get(c.primary.candidateId)!;
      insCluster.run(c.clusterKey, cp.title || r.title, String(r.vid), nowIso(), nowIso());
      const clusterId = (getCluster.get(c.clusterKey) as any).id;
      insMember.run(clusterId, r.vid, '主要来源', nowIso());
      for (const m of c.members) {
        const mr = byCid.get(m.candidateId);
        if (mr) insMember.run(clusterId, mr.vid, '补充来源', nowIso());
      }
      insItem.run(id, clusterId, String(r.vid), c.section, ++order,
        r.late_discovery ? 'late_discovery' : 'included',
        cp.title || r.title, cp.conclusion, JSON.stringify(cp.summary_sentences),
        r.source_id, r.url ?? '');
    }
    db.prepare(`INSERT INTO audit_events (run_id,entity_type,entity_id,action,payload_json,created_at)
      VALUES (?,?,?,?,?,?)`).run(run.id, 'brief', String(id), 'brief_composed',
      JSON.stringify({ items: order, htmlBytes: Buffer.byteLength(html, 'utf8'), version }), nowIso());
    return id;
  })());
  console.log(`已保存简报 #${briefId} v${version}（发送前先持久化，PRD 12.1）`);
}

// ---------- 7. 投递 ----------
const to = process.env.MAIL_TO ?? '';
if (NO_SEND) {
  console.log('--no-send：跳过投递');
} else if (!to) {
  console.log('未设置 MAIL_TO，跳过投递');
} else {
  const { mailer, kind, note } = mailerFromEnv(OUT_DIR);
  if (note) console.log(`投递通道：${kind} —— ${note}`);
  else console.log(`投递通道：${kind}`);

  const r = await deliver(db, mailer, {
    briefId, recipient: to,
    deliveryType: SHADOW ? 'shadow' : 'primary',
    subject, text, html,
    environment: SHADOW ? 'shadow' : undefined,
  });
  const icon = { sent: '✅', already_sent: '○', failed: '⚠️', permanent_failure: '❌' }[r.status];
  console.log(`${icon} 投递 ${r.status}` +
    (r.providerId ? ` id=${r.providerId}` : '') +
    (r.error ? ` 错误：${r.error}` : '') + ` （尝试 ${r.attempts} 次）`);
  if (r.status === 'permanent_failure')
    console.error('永久失败 —— 简报已持久化，修复凭证后可用后台补发');
}

db.prepare(`UPDATE runs SET status='succeeded', stage='sending', finished_at=? WHERE id=?`)
  .run(nowIso(), run.id);
db.close();
