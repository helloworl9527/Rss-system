#!/usr/bin/env node
/**
 * L2/L3 复核 CLI（PRD 15.1 / 15.4）。
 *
 *   node apps/worker/src/review.ts --run 2
 *   node apps/worker/src/review.ts --run 2 --dry
 *
 * 只处理 decision=escalate 的候选。名额有限时按重要性排序，
 * 挤不进的转人工而非丢弃（PRD 15.5）。
 */
import { readFileSync } from 'node:fs';
import { openDb, nowIso, sha256, type DB } from '../../../packages/db/src/index.ts';
import { hydrateEnv } from '../../../packages/web/src/secrets.ts';
import { loadRules } from '../../../packages/domain/src/rules.ts';
import { isHighRisk } from '../../../packages/domain/src/risk.ts';
import { createProvider, providerFromEnv } from '../../../packages/ai/src/registry.ts';
import { runReview, type ReviewInput, type ReviewDeps } from '../../../packages/ai/src/review.ts';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const runArg = argv.includes('--run') ? Number(argv[argv.indexOf('--run') + 1]) : null;

hydrateEnv();
const db: DB = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
const rules = loadRules();

const run = (runArg
  ? db.prepare('SELECT * FROM runs WHERE id=?').get(runArg)
  : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get()) as any;
if (!run) { console.log('没有可用的 run'); db.close(); process.exit(0); }

const promptText = readFileSync('./config/prompts/review.md', 'utf8');
const promptVersion = `review-v${rules.meta.rule_version}-${sha256(promptText).slice(0, 8)}`;
if (!DRY)
  db.prepare(`INSERT INTO prompt_versions (name,version,schema_hash,content_hash,content,active,created_at)
    VALUES ('review',?,?,?,?,1,?) ON CONFLICT(name,version) DO NOTHING`)
    .run(promptVersion, sha256(promptText).slice(0, 16), sha256(promptText).slice(0, 16), promptText, nowIso());

// ---- 取待复核候选 ----
type Row = {
  cid: number; vid: number; source_id: string; category: string; title: string;
  body: string; url: string | null; published_at: string | null;
  signals_json: string | null; prescreen_json: string | null;
  result_json: string | null; escalation_reasons: string | null;
};
const rows = db.prepare(`
  SELECT c.id cid, c.item_version_id vid, f.source_id, s.category, v.title,
         coalesce(v.fulltext_text, v.clean_text) body, f.canonical_url url, f.published_at,
         v.signals_json, v.prescreen_json, e.result_json, e.escalation_reasons
  FROM candidates c
  JOIN item_versions v ON v.id=c.item_version_id
  JOIN feed_items f ON f.id=v.item_id
  JOIN sources s ON s.id=f.source_id
  LEFT JOIN evaluations e ON e.candidate_id=c.id AND e.stage='luna'
  WHERE c.run_id=? AND c.decision='escalate'
    AND NOT EXISTS (SELECT 1 FROM evaluations e2
                    WHERE e2.candidate_id=c.id AND e2.stage IN ('terra','sol'))
  ORDER BY c.id`).all(run.id) as Row[];

if (!rows.length) { console.log(`run #${run.id} 没有待复核候选`); db.close(); process.exit(0); }

// ---- 同事件兄弟条目，供交叉核验（PRD 15.1 L2「多来源合并」）----
const siblingsOf = (cid: number, eventKey: string | null) => {
  if (!eventKey) return [];
  return (db.prepare(`
    SELECT f.source_id sourceId, v.title, f.canonical_url url,
           substr(coalesce(v.fulltext_text, v.clean_text), 1, 400) excerpt
    FROM candidates c JOIN item_versions v ON v.id=c.item_version_id
    JOIN feed_items f ON f.id=v.item_id
    JOIN evaluations e ON e.candidate_id=c.id AND e.stage='luna'
    WHERE c.run_id=? AND c.id<>? AND json_extract(e.result_json,'$.event_key')=?
    LIMIT 4`).all(run.id, cid, eventKey)) as any[];
};

const inputs: ReviewInput[] = rows.map(r => {
  let m: any = {}; try { m = r.result_json ? JSON.parse(r.result_json) : {}; } catch { /* ignore */ }
  const sig = r.signals_json ? JSON.parse(r.signals_json) as Record<string, boolean> : {};
  return {
    candidateId: `c${r.cid}`, sourceId: r.source_id, sourceKind: r.category,
    title: r.title, publishedAt: r.published_at, url: r.url, body: r.body,
    signals: Object.entries(sig).filter(([, v]) => v).map(([k]) => k),
    repos: [], officialLinks: [],
    prescreenClasses: r.prescreen_json ? JSON.parse(r.prescreen_json) : [],
    contentHash: '',
    priorDecision: m.decision ?? 'unknown',
    priorConfidence: m.confidence ?? 0,
    escalationRules: r.escalation_reasons ? JSON.parse(r.escalation_reasons) : [],
    siblings: siblingsOf(r.cid, m.event_key ?? null),
  };
});

// ---- 供应商：L2/L3 可指向不同厂商 ----
const l2cfg = providerFromEnv('L2'), l3cfg = providerFromEnv('L3');
// 未单独配置时沿用 L1
const fallback = providerFromEnv('L1');
const pick = (c: typeof l2cfg, tierModelEnv: string) => ({
  ...c,
  provider: c.provider !== 'mock' || process.env.AI_PROVIDER ? (c.provider ?? fallback.provider) : fallback.provider,
  model: c.model || process.env[tierModelEnv] || fallback.model,
  apiKey: c.apiKey ?? fallback.apiKey,
});
const l2 = await createProvider(pick(l2cfg, 'AI_L2_MODEL'));
const l3 = await createProvider(pick(l3cfg, 'AI_L3_MODEL'));

const bt = rules.ai?.budget_per_run ?? {};
const deps: ReviewDeps = {
  l2: { provider: l2, budget: { maxItems: bt.terra?.max_items ?? 5,
        inputTokensMax: bt.terra?.input_tokens_max ?? 25000,
        outputTokensMax: bt.terra?.output_tokens_max ?? 5000 } },
  l3: { provider: l3, budget: { maxItems: bt.sol?.max_items ?? 2,
        inputTokensMax: bt.sol?.input_tokens_max ?? 15000,
        outputTokensMax: bt.sol?.output_tokens_max ?? 3000 } },
  systemPrompt: promptText,
  bodyCharsMax: rules.ai?.input_minimization?.body_chars_max ?? 8000,
  isHighRisk,
};

console.log(`run #${run.id} ${run.window_key} | L2 ${l2.name}/${l2.model} · L3 ${l3.name}/${l3.model}`);
console.log(`待复核 ${inputs.length} 条 | L2 名额 ${deps.l2.budget.maxItems} · L3 名额 ${deps.l3.budget.maxItems}\n`);

const rep = await runReview(inputs, deps);

// ---- 落库 ----
if (!DRY) {
  const insEval = db.prepare(`INSERT INTO evaluations
    (candidate_id,stage,model,prompt_version,response_id,result_json,
     escalation_reasons,confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const updCand = db.prepare(`UPDATE candidates SET decision=?, mandatory_class=?,
    section=?, filter_reason=? WHERE id=?`);
  const audit = db.prepare(`INSERT INTO audit_events
    (run_id,entity_type,entity_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)`);

  db.transaction(() => {
    for (const o of rep.outcomes) {
      const cid = Number(o.candidateId.slice(1));
      const stage = o.tier === 'L3' ? 'sol' : 'terra';
      insEval.run(cid, stage, o.tier === 'L3' ? l3.model : l2.model, promptVersion,
        o.responseId ?? null,
        o.result ? JSON.stringify(o.result) : JSON.stringify({ error: o.error, status: o.status }),
        o.promoteRules.length ? JSON.stringify(o.promoteRules) : null,
        o.result?.confidence ?? null, nowIso());

      // 待升 L3 的先不定稿；L3 结果会在后续循环里覆盖
      if (o.result && !o.promote)
        updCand.run(o.result.decision, o.result.mandatory_class, o.result.section,
                    o.result.filter_reason, cid);
      else if (!o.result)
        audit.run(run.id, 'candidate', String(cid),
          o.status === 'skipped' ? 'review_budget_skipped' : 'review_manual_audit',
          JSON.stringify({ tier: o.tier, error: o.error }), nowIso());
    }
  })();
}

// ---- 报告 ----
const byTier = (t: string, s: string) => rep.outcomes.filter(o => o.tier === t && o.status === s).length;
console.log(`L2：处理 ${rep.l2Used.items} 条（成功 ${byTier('L2', 'ok')}，转人工 ${byTier('L2', 'manual_audit')}，名额不足 ${byTier('L2', 'skipped')}）`);
if (rep.l3Used.items) console.log(`L3：处理 ${rep.l3Used.items} 条（成功 ${byTier('L3', 'ok')}）`);
if (rep.deferred.length) console.log(`⏸ ${rep.deferred.length} 条因名额不足转人工审阅`);

const changes = rep.outcomes.filter(o => o.result);
if (changes.length) {
  console.log('\n复核结论：');
  for (const o of changes.slice(0, 12)) {
    const r = rows.find(x => `c${x.cid}` === o.candidateId)!;
    const cls = o.result!.mandatory_class !== 'none' ? `[${o.result!.mandatory_class}] ` : '';
    console.log(`  ${o.tier} ${cls}${o.result!.decision.padEnd(7)} ${r.title.slice(0, 36)}`);
    if (o.result!.conflicts.length) console.log(`      冲突：${o.result!.conflicts.join('；')}`);
    if (o.promote) console.log(`      → 升 L3（${o.promoteRules.join(' ')}）`);
  }
}
console.log(DRY ? '\n(--dry，未落库)' : '');
db.close();
