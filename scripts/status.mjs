#!/usr/bin/env node
// 采集健康速览：node scripts/status.mjs
import { openDb } from '../packages/db/src/index.ts';
const db = openDb(process.env.DATABASE_PATH ?? '/var/lib/briefing/brief.db');
const A = (s, ...a) => db.prepare(s).all(...a);
const G = (s, ...a) => db.prepare(s).get(...a);
const ago = (t) => t ? `${Math.round((Date.now() - Date.parse(t)) / 60000)}分钟前` : '从未';

const r = G(`SELECT * FROM harvest_runs ORDER BY id DESC LIMIT 1`);
console.log(`最近采集 #${r?.id ?? '-'}  ${r?.status ?? '-'}  ${ago(r?.started_at)}` +
            `  来源 ${r?.sources_ok}/${r?.sources_attempted}  新条目 ${r?.new_items}`);

const day = G(`SELECT count(*) runs, sum(new_items) items, sum(new_versions) vers
               FROM harvest_runs WHERE started_at > datetime('now','-24 hours')`);
console.log(`近 24h：${day.runs} 轮，新条目 ${day.items ?? 0}，新版本 ${day.vers ?? 0}`);
console.log(`累计：条目 ${G('SELECT count(*) c FROM feed_items').c}，版本 ${G('SELECT count(*) c FROM item_versions').c}\n`);

console.log('来源健康：');
for (const s of A(`SELECT id, health, consecutive_failures f, last_success_at, last_error,
                          harvest_tier t FROM sources WHERE enabled=1 ORDER BY
                   CASE health WHEN 'failing' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, id`)) {
  const icon = s.health === 'healthy' ? '✅' : s.health === 'degraded' ? '⚠️ ' : s.health === 'failing' ? '❌' : '·';
  console.log(`  ${icon} ${s.id.padEnd(16)} ${String(s.t).padEnd(18)} 最近成功 ${ago(s.last_success_at).padEnd(12)}` +
              (s.f ? ` 连续失败 ${s.f}` : '') + (s.last_error ? `  ${String(s.last_error).slice(0, 40)}` : ''));
}

const fb = A(`SELECT source_id, endpoint_priority p, count(*) c FROM fetch_attempts
              WHERE started_at > datetime('now','-24 hours') AND endpoint_priority > 1
              GROUP BY 1,2`);
console.log(fb.length ? `\n近 24h 回退：${fb.map(x => `${x.source_id}→P${x.p}×${x.c}`).join(', ')}`
                      : '\n近 24h 无端点回退');

const pend = G(`SELECT count(*) c FROM item_versions WHERE is_excerpt=1 AND fulltext_status IS NULL`);
if (pend.c) console.log(`待抓原帖全文：${pend.c} 条（forum_fulltext 抓取器尚未实现）`);
db.close();
