#!/usr/bin/env node
/**
 * 采集器（实施方案 2.1）—— 纯 I/O：抓取 → 解析 → 归一化 → 落库。
 * 不调用 AI、不发邮件、不做窗口筛选。三次简报运行改为从库里读。
 *
 *   node apps/worker/src/harvest.ts            按 tier 采集到期来源
 *   node apps/worker/src/harvest.ts --all      忽略 tier，全部采集
 *   node apps/worker/src/harvest.ts --source X 只采集指定来源
 */
import { fetchAllnet, parseAllnet, type Subscription } from '../../../packages/connectors/src/allnet.ts';
import { fetchArticle } from '../../../packages/connectors/src/fulltext.ts';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, nowIso, sha256, type DB } from '../../../packages/db/src/index.ts';
import { loadRules, loadSources } from '../../../packages/domain/src/rules.ts';
import {
  canonicalizeUrl, extractItemKey, stripHtml, contentFingerprint,
  substantiveUpdateSignals, isExcerpt, normalizeTime, windowOf,
} from '../../../packages/domain/src/normalize.ts';
import { Throttler } from '../../../packages/connectors/src/throttle.ts';
import { fetchWithFallback, type Endpoint } from '../../../packages/connectors/src/fetch.ts';
import { parseBy } from '../../../packages/connectors/src/parsers.ts';
import { openCircuitHosts, recordHostSuccess, recordRateLimit } from './host-circuit.ts';

const argv = process.argv.slice(2);
const FORCE_ALL = argv.includes('--all');
const ONLY = argv.includes('--source') ? argv[argv.indexOf('--source') + 1] : null;

const DB_PATH = process.env.DATABASE_PATH ?? './data/brief.db';
const SNAP_DIR = process.env.SNAPSHOT_DIR ?? './data/snapshots';

const db: DB = openDb(DB_PATH);
const rules = loadRules();
const scfg = loadSources();
const throttler = new Throttler(scfg.host_groups);
const tiers: Record<string, number> = scfg.harvest_tiers;
const defaults = scfg.defaults;

// ---- 选出到期来源 ----
type SrcRow = {
  id: string; name: string; harvest_tier: string; host_group: string;
  config_json: string; last_attempt_at: string | null; consecutive_failures: number;
};
const all = db.prepare('SELECT * FROM sources WHERE enabled=1 OR EXISTS (SELECT 1 FROM allnet_subscriptions a WHERE a.source_id=sources.id AND a.collection_enabled=1) ORDER BY priority, id').all() as SrcRow[];
const now = Date.now();
const due = all.filter(s => {
  if (ONLY) return s.id === ONLY;
  if (FORCE_ALL) return true;
  const iv = (tiers[s.harvest_tier] ?? 60) * 60_000;
  return !s.last_attempt_at || now - Date.parse(s.last_attempt_at) >= iv;
});

if (!due.length) { console.log('无到期来源'); db.close(); process.exit(0); }

// ---- 建 harvest_run ----
const runIns = db.prepare(`INSERT INTO harvest_runs (started_at,status,tiers_json) VALUES (?,'running',?)`);
const runId = Number(runIns.run(nowIso(), JSON.stringify([...new Set(due.map(s => s.harvest_tier))])).lastInsertRowid);

// ---- 预备语句 ----
const q = {
  eps: db.prepare('SELECT * FROM source_endpoints WHERE source_id=? AND enabled=1 ORDER BY priority'),
  attempt: db.prepare(`INSERT INTO fetch_attempts
    (harvest_run_id,source_id,endpoint_id,endpoint_priority,url,started_at,latency_ms,
     outcome,http_code,bytes,content_hash,parsed_count,error_class,error_message,is_fallback,fallback_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  snapExists: db.prepare('SELECT id FROM raw_snapshots WHERE content_hash=? AND source_id=?'),
  snapIns: db.prepare(`INSERT INTO raw_snapshots
    (fetch_attempt_id,source_id,storage_path,content_hash,bytes_raw,bytes_stored,captured_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?)`),
  epCache: db.prepare('UPDATE source_endpoints SET etag=?, last_modified=? WHERE id=?'),
  itemGet: db.prepare('SELECT * FROM feed_items WHERE source_id=? AND source_item_key=?'),
  itemIns: db.prepare(`INSERT INTO feed_items
    (source_id,source_item_key,key_kind,canonical_url,origin_url,discovery_url,
     published_at,published_at_taipei,published_at_raw,timestamp_confidence,
     first_seen_at,first_seen_harvest_run_id,origin_window_key,last_seen_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  itemTouch: db.prepare('UPDATE feed_items SET last_seen_at=? WHERE id=?'),
  itemCur: db.prepare('UPDATE feed_items SET current_version_id=? WHERE id=?'),
  verGet: db.prepare('SELECT id FROM item_versions WHERE item_id=? AND content_hash=?'),
  verMax: db.prepare('SELECT max(version_no) n FROM item_versions WHERE item_id=?'),
  verIns: db.prepare(`INSERT INTO item_versions
    (item_id,content_hash,raw_hash,title,clean_text,html_excerpt,is_excerpt,
     fulltext_status,discovered_at,version_no,is_substantive_update,update_signals_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  srcOk: db.prepare(`UPDATE sources SET health='healthy', consecutive_failures=0,
    last_success_at=?, last_attempt_at=?, last_http_code=?, last_error=NULL,
    latest_item_at=max(coalesce(latest_item_at,''), coalesce(?, '')), updated_at=? WHERE id=?`),
  srcFail: db.prepare(`UPDATE sources SET consecutive_failures=consecutive_failures+1,
    health=CASE WHEN consecutive_failures+1>=3 THEN 'failing' ELSE 'degraded' END,
    last_attempt_at=?, last_http_code=?, last_error=?, updated_at=? WHERE id=?`),
  audit: db.prepare(`INSERT INTO audit_events
    (harvest_run_id,entity_type,entity_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)`),
};

const retentionDays = Number(process.env.RAW_SNAPSHOT_RETENTION_DAYS ?? 30);

let okCount = 0, newItems = 0, newVersions = 0;
const lines: string[] = [];

for (const src of due) {
  const cfgS = JSON.parse(src.config_json);
  const eps = q.eps.all(src.id) as any[];
  const t0 = Date.now();

  const subscription = db.prepare('SELECT * FROM allnet_subscriptions WHERE source_id=?').get(src.id) as Subscription | undefined;
  const { attempts, success } = subscription ? await fetchAllnet(db, subscription) : await fetchWithFallback(
    eps as Endpoint[], throttler,
    { userAgent: defaults.user_agent,
      maxBytes: cfgS.max_body_bytes ?? defaults.max_body_bytes },
    openCircuitHosts(db));

  // 将 403/429 熔断持久化。相同主机的其它端点本轮已由连接器跳过，
  // 后续轮次也会等冷却结束；镜像位于不同主机，不受影响。
  for (const a of attempts) {
    let host = '';
    try { host = new URL(a.endpoint.url).hostname; } catch { /* 已由抓取结果记录错误 */ }
    if (host && a.outcome === 'rate_limited') {
      const until = recordRateLimit(db, host, a.httpCode, a.errorMessage);
      lines.push(`  ⏸ ${host} 已熔断至 ${until}`);
    }
  }
  if (success) {
    let successHost = '';
    try { successHost = new URL(success.endpoint.url).hostname; } catch { /* ignore */ }
    if (successHost) recordHostSuccess(db, successHost);
  }

  // 所有尝试都落审计（PRD 18：回退过程必须可见）
  let attemptIds: number[] = [];
  db.transaction(() => {
    for (const a of attempts) {
      const hash = a.body ? sha256(a.body) : null;
      const id = q.attempt.run(runId, src.id, a.endpoint.id ?? null, a.endpoint.priority,
        a.endpoint.url, nowIso(), a.latencyMs, a.outcome, a.httpCode ?? null,
        a.bytes ?? null, hash, null, a.errorClass ?? null, a.errorMessage ?? null,
        a.isFallback ? 1 : 0,
        a.isFallback ? `priority ${a.endpoint.priority - 1} 失败` : null).lastInsertRowid;
      attemptIds.push(Number(id));
    }
  })();

  if (!success) {
    const last = attempts.at(-1);
    q.srcFail.run(nowIso(), last?.httpCode ?? null, last?.errorMessage ?? '全部端点失败', nowIso(), src.id);
    lines.push(`  ❌ ${src.id.padEnd(16)} 全部 ${attempts.length} 个端点失败 (${last?.errorClass})`);
    continue;
  }

  if (success.outcome === 'not_modified') {
    okCount++;
    q.srcOk.run(nowIso(), nowIso(), 304, null, nowIso(), src.id);
    lines.push(`  ○ ${src.id.padEnd(16)} 304 无更新`);
    continue;
  }

  if (success.endpoint.id)
    q.epCache.run(success.etag ?? null, success.lastModified ?? null, success.endpoint.id);

  // ---- 落原始快照（内容未变则不重复落盘） ----
  const body = success.body!;
  const hash = sha256(body);
  const aid = attemptIds[attempts.indexOf(success)]!;
  if (!q.snapExists.get(hash, src.id)) {
    const d = new Date();
    const dir = join(SNAP_DIR, String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    const gz = gzipSync(Buffer.from(body, 'utf8'));
    const path = join(dir, `${hash.slice(0, 32)}.gz`);
    writeFileSync(path, gz);
    q.snapIns.run(aid, src.id, path, hash, Buffer.byteLength(body), gz.byteLength,
      nowIso(), new Date(Date.now() + retentionDays * 86400e3).toISOString());
  }

  // ---- 解析 ----
  let raws;
  try {
    const channel = /telegram\/channel\/([^/?]+)|t\.me\/s\/([^/?]+)/.exec(success.endpoint.url);
    raws = subscription ? parseAllnet(JSON.parse(body), subscription) : parseBy(success.endpoint.parser, body, { channel: channel?.[1] ?? channel?.[2] });
  } catch (e: any) {
    q.srcFail.run(nowIso(), success.httpCode ?? null, `解析失败: ${e.message}`, nowIso(), src.id);
    lines.push(`  ❌ ${src.id.padEnd(16)} 解析失败: ${e.message}`);
    continue;
  }
  // 200 但解析出 0 条 → source_anomaly，不得写成「无更新」（PRD 18）
  if (raws.length === 0) {
    q.srcFail.run(nowIso(), success.httpCode ?? null, '200 但解析出 0 条', nowIso(), src.id);
    q.audit.run(runId, 'source', src.id, 'source_anomaly',
      JSON.stringify({ url: success.endpoint.url, bytes: success.bytes }), nowIso());
    lines.push(`  ⚠ ${src.id.padEnd(16)} 来源异常：200 但 0 条`);
    continue;
  }

  // Meituan article enrichment uses the original host without API credentials.
  // Reuse saved article content to avoid refetching history and creating title-only versions.
  if (subscription?.upstream_id === 864) {
    for (const r of raws) {
      const prior = r.link ? db.prepare(`SELECT f.published_at, v.clean_text FROM feed_items f
        JOIN item_versions v ON v.id=f.current_version_id WHERE f.source_id=? AND f.canonical_url=?`).get(src.id, canonicalizeUrl(r.link)) as any : null;
      if(prior) { r.publishedRaw=prior.published_at; r.html=prior.clean_text; continue; }
      if (r.link && new URL(r.link).origin === 'https://tech.meituan.com') {
        await new Promise(resolve => setTimeout(resolve, 300));
        const article = await fetchArticle(r.link, {userAgent:defaults.user_agent,timeoutMs:15000,maxBytes:2*1024*1024});
        if (article.ok) { r.html=article.text??''; r.publishedRaw=article.publishedRaw??null; }
        // Meituan's dated permalink is an original-site date, never the harvest time.
        const date = new URL(r.link).pathname.match(/^\/(\d{4})\/(\d{2})\/(\d{2})\//);
        if (!r.publishedRaw && date) r.publishedRaw=`${date[1]}-${date[2]}-${date[3]}T00:00:00+08:00`;
      }
    }
  }

  const previousSnapshotKeys = new Set<string>(subscription?.snapshot_json ? JSON.parse(subscription.snapshot_json).map((r:any)=>r.guid) : []);
  // ---- 归一化 + 落库 ----
  let ni = 0, nv = 0, latest: string | null = null;
  db.transaction(() => {
    for (const r of raws) {
      const cu = r.link ? canonicalizeUrl(r.link) : null;
      const t = normalizeTime(r.publishedRaw, cfgS.assumed_timezone ?? defaults.assumed_timezone,
        { historicalArchive: !!cfgS.historical_archive });
      if (t.utc && (!latest || t.utc > latest)) latest = t.utc;
      if (subscription?.upstream_id === 864 && !t.utc) t.confidence = 'stale';
      const k = extractItemKey(r.link, r.guid, src.id, r.title, t.utc);

      let item = q.itemGet.get(src.id, k.key) as any;
      if (!item) {
        const discoveredAt = subscription?.snapshot_at && r.guid && previousSnapshotKeys.has(r.guid) ? subscription.snapshot_at : nowIso();
        const win = t.utc ? windowOf(new Date(t.utc)).key : null;
        const id = q.itemIns.run(src.id, k.key, k.kind, cu, null, r.link ?? null,
          t.utc, t.taipei, t.raw, t.confidence, discoveredAt, runId, win, nowIso(), nowIso()).lastInsertRowid;
        item = { id: Number(id) };
        ni++;
      } else {
        q.itemTouch.run(nowIso(), item.id);
      }

      const clean = stripHtml(r.html || r.title);
      const fp = contentFingerprint(clean);
      if (q.verGet.get(item.id, fp)) continue;      // 该版本已存在

      const prevMax = (q.verMax.get(item.id) as any)?.n ?? 0;
      const sigs = prevMax > 0 ? substantiveUpdateSignals(clean) : [];
      const excerpt = isExcerpt(clean, src.id);
      const vid = q.verIns.run(item.id, fp, sha256(r.html || r.title), r.title, clean,
        r.html.slice(0, 4000), excerpt ? 1 : 0,
        cfgS.require_fulltext ? null : 'not_needed',
        nowIso(), prevMax + 1, sigs.length ? 1 : 0,
        sigs.length ? JSON.stringify(sigs) : null).lastInsertRowid;
      q.itemCur.run(Number(vid), item.id);
      nv++;
    }
  })();

  if (subscription) db.prepare('UPDATE allnet_subscriptions SET snapshot_json=?,snapshot_at=? WHERE source_id=?').run(JSON.stringify(raws),nowIso(),src.id);
  okCount++;
  newItems += ni; newVersions += nv;
  q.srcOk.run(nowIso(), nowIso(), success.httpCode ?? 200, latest, nowIso(), src.id);
  const fb = success.isFallback ? ` [回退→P${success.endpoint.priority}]` : '';
  lines.push(`  ✅ ${src.id.padEnd(16)} ${String(raws.length).padStart(3)} 条 | 新条目 ${String(ni).padStart(3)} | 新版本 ${String(nv).padStart(3)} | ${((Date.now() - t0) / 1000).toFixed(1)}s${fb}`);
}

db.prepare(`UPDATE harvest_runs SET finished_at=?, status=?, sources_attempted=?,
  sources_ok=?, new_items=?, new_versions=? WHERE id=?`)
  .run(nowIso(), okCount === due.length ? 'succeeded' : okCount ? 'partial' : 'failed',
       due.length, okCount, newItems, newVersions, runId);

// V2.2: approved sources remain in a three-window observation period before
// becoming ACTIVE. The period is time-bounded so a healthy source graduates
// automatically after the required windows have been observed.
db.prepare(`UPDATE sources SET onboarding_status='ACTIVE', updated_at=?
  WHERE onboarding_status='OBSERVATION' AND observation_until IS NOT NULL
    AND observation_until <= datetime('now')`).run(nowIso());

console.log(`采集轮次 #${runId}  (${due.length} 个到期来源${FORCE_ALL ? ', --all' : ''})`);
lines.forEach(l => console.log(l));
console.log(`─ 成功 ${okCount}/${due.length} | 新条目 ${newItems} | 新版本 ${newVersions}`);
db.close();
