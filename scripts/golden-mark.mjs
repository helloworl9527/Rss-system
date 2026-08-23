#!/usr/bin/env node
/**
 * 把人工反馈写入黄金集（PRD 23.3 / 24.1）。
 *
 *   node scripts/golden-mark.mjs keep c123 c145 c160
 *   node scripts/golden-mark.mjs keep c123 --class A
 *   node scripts/golden-mark.mjs drop c200 c201        确认「过滤是对的」
 *   node scripts/golden-mark.mjs list                  看已标注进度
 *
 * 邮件附录里每条被过滤/待复核的条目都带编号（c<候选ID>）。
 * 人工回复「保留 c123 c145」后用本脚本落库 —— 这些标注是
 * human_confirmed 的，会直接计入 golden-eval 的召回率评估。
 *
 * 「过滤是对的」同样有价值：它构成负例，用于衡量错误过滤率。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { openDb } from '../packages/db/src/index.ts';
import { extractSignals, prescreenMandatory } from '../packages/domain/src/signals.ts';

const FILE = 'tests/golden/samples.json';
const argv = process.argv.slice(2);
const cmd = argv[0];
const clsIdx = argv.indexOf('--class');
const forcedClass = clsIdx > 0 ? argv[clsIdx + 1] : null;
const refs = argv.slice(1).filter(a => /^c\d+$/i.test(a)).map(a => a.toLowerCase());

const db = openDb(process.env.DATABASE_PATH ?? '/var/lib/briefing/brief.db');
const all = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
const byId = new Map(all.map(s => [s.id, s]));

if (cmd === 'list') {
  const conf = all.filter(s => s.labelSource === 'human_confirmed');
  const cls = {};
  for (const s of conf) cls[s.expected.mandatoryClass] = (cls[s.expected.mandatoryClass] ?? 0) + 1;
  console.log(`黄金集 ${all.length} 条，人工确认 ${conf.length} 条`);
  console.log(`  类别分布: ${Object.entries(cls).map(([k, v]) => `${k}=${v}`).join(' ') || '（无）'}`);
  console.log(`  保留正例: ${conf.filter(s => s.expected.decision !== 'filter').length}`);
  console.log(`  过滤负例: ${conf.filter(s => s.expected.decision === 'filter').length}`);
  console.log('\nPRD 23.3 覆盖度：');
  for (const [name, need, got] of [
    ['A 类正例', 20, conf.filter(s => s.expected.mandatoryClass === 'A').length],
    ['B 类正例', 20, conf.filter(s => s.expected.mandatoryClass === 'B').length],
    ['C 类正例', 20, conf.filter(s => s.expected.mandatoryClass === 'C').length],
    ['D 类正例', 20, conf.filter(s => s.expected.mandatoryClass === 'D').length],
    ['过滤负例', 20, conf.filter(s => s.expected.decision === 'filter').length],
    ['总量', 200, conf.length],
  ]) console.log(`  ${got >= need ? '✅' : '⏳'} ${name.padEnd(10)} ${got}/${need}`);
  db.close(); process.exit(0);
}

if (cmd !== 'keep' && cmd !== 'drop') {
  console.error('用法: golden-mark.mjs keep|drop c123 c145 …   |   golden-mark.mjs list');
  process.exit(1);
}
if (!refs.length) { console.error('没有识别到候选编号（形如 c123）'); process.exit(1); }

const host = { linuxdo: 'linux.do', v2ex: 'v2ex.com', elsewhere: 'elsewhere.news' };
const q = db.prepare(`
  SELECT c.id cid, f.source_id, f.canonical_url url, v.title,
         coalesce(v.fulltext_text, v.clean_text) body,
         coalesce(v.fulltext_html, v.html_excerpt) html,
         v.is_excerpt, v.fulltext_status, c.decision, c.filter_reason, c.filter_rule_id,
         v.prescreen_json
  FROM candidates c
  JOIN item_versions v ON v.id = c.item_version_id
  JOIN feed_items f ON f.id = v.item_id
  WHERE c.id = ?`);

let added = 0, updated = 0, missing = [];
for (const ref of refs) {
  const cid = Number(ref.slice(1));
  const r = q.get(cid);
  if (!r) { missing.push(ref); continue; }

  const d = extractSignals(r.body ?? '', r.html ?? '', host[r.source_id] ?? '');
  const auto = prescreenMandatory(d.signals);
  const id = `v${cid}`;
  const isKeep = cmd === 'keep';
  const cls = forcedClass ?? (isKeep ? (auto[0] ?? 'none') : 'none');

  const sample = {
    id, source: r.source_id, url: r.url, title: r.title, body: r.body ?? '',
    bodyIsExcerpt: !!r.is_excerpt && r.fulltext_status !== 'ok',
    expected: {
      decision: isKeep ? (cls !== 'none' ? 'retain' : 'normal') : 'filter',
      mandatoryClass: cls,
      section: null,
      filterRuleId: isKeep ? null : (r.filter_rule_id ?? null),
      sameEventAs: byId.get(id)?.expected?.sameEventAs ?? [],
      mustMention: byId.get(id)?.expected?.mustMention ?? [],
    },
    extracted: {
      signals: Object.entries(d.signals).filter(([, v]) => v).map(([k]) => k),
      repos: d.repos, officialLinks: d.officialLinks, prescreenClasses: auto,
    },
    labelSource: 'human_confirmed',
    note: isKeep
      ? `人工判定应收录（系统原判 ${r.decision}${r.filter_reason ? '：' + String(r.filter_reason).slice(0, 60) : ''}）`
      : `人工确认过滤正确（${r.filter_rule_id ?? '模型判定'}）`,
    tags: Object.entries(d.signals).filter(([, v]) => v).map(([k]) => k),
  };

  if (byId.has(id)) updated++; else added++;
  byId.set(id, sample);

  const mark = isKeep ? '保留' : '过滤';
  const flag = isKeep && auto.length === 0 ? '  ⚠️ 程序预判无 A–D 证据，属纯语义漏判' : '';
  console.log(`  ${mark} ${ref}  [${cls}]  ${String(r.title).slice(0, 40)}${flag}`);
}

writeFileSync(FILE, JSON.stringify([...byId.values()], null, 2));
console.log(`\n黄金集：新增 ${added}，更新 ${updated}` + (missing.length ? `，未找到 ${missing.join(' ')}` : ''));

const conf = [...byId.values()].filter(s => s.labelSource === 'human_confirmed');
console.log(`人工确认累计 ${conf.length} 条（PRD 23.3 要求 ≥200）`);
console.log('跑 npm run golden:eval -- --confirmed-only 可用这些标注评估当前规则与模型');
db.close();
