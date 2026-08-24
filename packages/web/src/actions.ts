import type { DB } from '../../db/src/index.ts';
import { nowIso } from '../../db/src/index.ts';
import { checkUrlSafe } from '../../connectors/src/ssrf.ts';
import { fetchSmart } from '../../connectors/src/fetch.ts';
import { parseBy } from '../../connectors/src/parsers.ts';

/**
 * 后台写操作（PRD 16.4 / 16.5 / FR-054 / FR-062 / 19.2）。
 *
 * 三条贯穿所有写操作的约束：
 *  1. 必须填理由 —— 无理由的覆盖等于无法追溯的黑箱（PRD 16.4）。
 *  2. 必须写 audit_events —— 人工覆盖、补发、停用来源都要留痕（PRD 19.2）。
 *  3. 人工判断优先于模型（FR-034），覆盖后不得被后续 AI 判定悄悄改回。
 */

export class ActionError extends Error {
  code: number;
  constructor(code: number, msg: string) { super(msg); this.code = code; this.name = 'ActionError'; }
}

const requireReason = (reason: unknown): string => {
  const r = String(reason ?? '').trim();
  if (r.length < 4) throw new ActionError(400, '必须填写覆盖理由（至少 4 个字）');
  if (r.length > 500) throw new ActionError(400, '理由过长');
  return r;
};

function audit(db: DB, o: {
  runId?: number | null; entityType: string; entityId: string;
  action: string; payload: unknown;
}): void {
  db.prepare(`INSERT INTO audit_events (run_id,entity_type,entity_id,action,payload_json,created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(o.runId ?? null, o.entityType, o.entityId, o.action,
         JSON.stringify(o.payload), nowIso());
}

// ---------- 候选人工覆盖（FR-062 / 16.4） ----------

export type OverrideAction = 'include' | 'filter' | 'reclassify' | 'lock';

export type OverrideInput = {
  candidateId: number;
  action: OverrideAction;
  reason: string;
  /** once = 仅本次；permanent = 对该 topic/URL 建立永久规则（PRD 16.4） */
  scope?: 'once' | 'permanent';
  mandatoryClass?: string | null;
  section?: string | null;
  actor?: string;
};

export function overrideCandidate(db: DB, o: OverrideInput): { ok: true; decision: string } {
  const reason = requireReason(o.reason);
  const scope = o.scope === 'permanent' ? 'permanent' : 'once';

  const c = db.prepare(`SELECT c.*, f.source_id, f.canonical_url, f.source_item_key
    FROM candidates c JOIN item_versions v ON v.id=c.item_version_id
    JOIN feed_items f ON f.id=v.item_id WHERE c.id=?`).get(o.candidateId) as any;
  if (!c) throw new ActionError(404, '候选不存在');

  let decision = c.decision;
  let mandatoryClass = c.mandatory_class;
  let section = c.section;

  switch (o.action) {
    case 'include':
      decision = mandatoryClass && mandatoryClass !== 'none' ? 'retain' : 'normal';
      break;
    case 'filter':
      decision = 'filter';
      break;
    case 'reclassify':
      if (o.mandatoryClass && !/^[ABCD]$|^none$/.test(o.mandatoryClass))
        throw new ActionError(400, '类别必须是 A/B/C/D/none');
      mandatoryClass = o.mandatoryClass ?? mandatoryClass;
      if (o.section) section = o.section;
      if (mandatoryClass && mandatoryClass !== 'none') decision = 'retain';
      break;
    case 'lock':
      break;   // 只锁定当前判定，不改值
    default:
      throw new ActionError(400, '未知操作');
  }

  db.transaction(() => {
    db.prepare(`UPDATE candidates SET decision=?, mandatory_class=?, section=?,
      filter_reason=CASE WHEN ?='filter' THEN ? ELSE filter_reason END WHERE id=?`)
      .run(decision, mandatoryClass, section, o.action, `人工：${reason}`, o.candidateId);

    db.prepare(`INSERT INTO manual_overrides
      (target_type,target_id,action,reason,scope,actor,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run('candidate', String(o.candidateId), o.action, reason, scope,
           o.actor ?? 'owner', nowIso());

    // 永久规则：以 canonical key 为准，后续同条目直接沿用（PRD 16.4）
    if (scope === 'permanent') {
      const key = c.canonical_url || `${c.source_id}:${c.source_item_key}`;
      db.prepare(`INSERT INTO manual_overrides
        (target_type,target_id,action,reason,scope,actor,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run('canonical_key', key, o.action, reason, 'permanent', o.actor ?? 'owner', nowIso());
    }

    audit(db, { runId: c.run_id, entityType: 'candidate', entityId: String(o.candidateId),
      action: `manual_${o.action}`,
      payload: { reason, scope, from: c.decision, to: decision,
                 mandatoryClass, section, actor: o.actor ?? 'owner' } });
  })();

  return { ok: true, decision };
}

/** 查询某 canonical key 上是否有生效的永久覆盖（供后续运行沿用）。 */
export function permanentOverrideFor(db: DB, canonicalKey: string): { action: string; reason: string } | null {
  const r = db.prepare(`SELECT action, reason FROM manual_overrides
    WHERE target_type='canonical_key' AND target_id=? AND scope='permanent'
    ORDER BY id DESC LIMIT 1`).get(canonicalKey) as any;
  return r ?? null;
}

// ---------- 来源启停（FR-001） ----------

export function toggleSource(db: DB, id: string, enabled: boolean, reason: string, actor = 'owner') {
  const r = requireReason(reason);
  const s = db.prepare('SELECT id, enabled FROM sources WHERE id=?').get(id) as any;
  if (!s) throw new ActionError(404, '来源不存在');

  db.transaction(() => {
    db.prepare('UPDATE sources SET enabled=?, updated_at=? WHERE id=?')
      .run(enabled ? 1 : 0, nowIso(), id);
    db.prepare(`INSERT INTO manual_overrides
      (target_type,target_id,action,reason,scope,actor,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run('source', id, enabled ? 'enable' : 'disable', r, 'permanent', actor, nowIso());
    audit(db, { entityType: 'source', entityId: id,
      action: enabled ? 'source_enabled' : 'source_disabled',
      payload: { reason: r, from: !!s.enabled, to: enabled, actor } });
  })();
  return { ok: true as const, enabled };
}

// ---------- 简报补发（FR-054 / 16.5） ----------

export type ResendPlan = {
  briefId: number;
  subject: string;
  recipient: string;
  /** 已投递过的记录，补发前必须展示给用户确认（PRD 16.5） */
  priorDeliveries: Array<{ type: string; sequence: number; status: string; sentAt: string | null }>;
  nextSequence: number;
  htmlBytes: number;
};

/**
 * 补发前的确认信息。PRD 16.5 要求「补发前显示与原 brief 的差异、
 * 已发时间和新主题行，避免误操作」—— 所以补发是两步：先 plan，后 execute。
 */
export function planResend(db: DB, briefId: number, recipient: string): ResendPlan {
  const b = db.prepare('SELECT id, subject, html_bytes FROM briefs WHERE id=?').get(briefId) as any;
  if (!b) throw new ActionError(404, '简报不存在');

  const prior = db.prepare(`SELECT delivery_type type, resend_sequence sequence, status, sent_at sentAt
    FROM deliveries WHERE brief_id=? AND recipient=? ORDER BY id`).all(briefId, recipient) as any[];
  const maxSeq = prior.filter(p => p.type === 'resend')
    .reduce((m, p) => Math.max(m, p.sequence), 0);

  return { briefId, subject: b.subject, recipient, priorDeliveries: prior,
           nextSequence: maxSeq + 1, htmlBytes: b.html_bytes };
}

/**
 * 执行补发。必须显式确认 —— 默认不重发是 PRD 12.3 的硬要求。
 * 实际发送由调用方注入的 mailer 完成，这里只负责校验、审计与幂等记录。
 */
export async function executeResend(
  db: DB,
  send: (o: { briefId: number; recipient: string; sequence: number }) => Promise<{ ok: boolean; providerId?: string; error?: string }>,
  o: { briefId: number; recipient: string; reason: string; confirmedSequence: number; actor?: string },
): Promise<{ ok: boolean; sequence: number; providerId?: string; error?: string }> {
  const reason = requireReason(o.reason);
  const plan = planResend(db, o.briefId, o.recipient);

  // 序号必须与用户看到的一致 —— 期间若有别的补发，说明页面已过期
  if (plan.nextSequence !== o.confirmedSequence)
    throw new ActionError(409, `补发序号已变化（页面显示 ${o.confirmedSequence}，当前应为 ${plan.nextSequence}），请刷新后重试`);

  const res = await send({ briefId: o.briefId, recipient: o.recipient, sequence: plan.nextSequence });

  db.transaction(() => {
    db.prepare(`INSERT INTO manual_overrides
      (target_type,target_id,action,reason,scope,actor,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run('brief', String(o.briefId), 'resend', reason, 'once', o.actor ?? 'owner', nowIso());
    audit(db, { entityType: 'brief', entityId: String(o.briefId), action: 'manual_resend',
      payload: { reason, recipient: o.recipient, sequence: plan.nextSequence,
                 ok: res.ok, error: res.error ?? null, actor: o.actor ?? 'owner' } });
  })();

  return { ok: res.ok, sequence: plan.nextSequence,
           providerId: res.providerId, error: res.error };
}

// ---------- 来源管理（FR-001 / FR-004） ----------

export const PARSERS = ['rss', 'atom', 'telegram_web', 'deepseek_page'] as const;
export const CATEGORIES = ['ai', 'developer', 'tech', 'article', 'society', 'forum'] as const;
export const TIERS = ['ranking_feed', 'standard', 'official_changelog', 'slow'] as const;

export type SourceInput = {
  id: string; name: string; url: string; parser: string;
  category: string; tier: string; priority?: number;
  requireFulltext?: boolean; mandatoryRetention?: boolean;
  actor?: string;
};

const SOURCE_ID = /^[a-z][a-z0-9_]{1,31}$/;

/**
 * 测试抓取（FR-004：不得写入正式简报，但保存诊断日志）。
 * 先过 SSRF 校验 —— 这个接口让用户指定 URL 由服务器发起请求，
 * 不校验就是把内网探测能力开放给了任何登录者（PRD 4.4）。
 */
export async function testSource(
  db: DB, o: { url: string; parser: string; sourceId?: string | null; actor?: string },
): Promise<{ ok: boolean; outcome: string; httpCode?: number; bytes?: number;
             parsedCount?: number; sample: Array<{ title: string; link: string | null; publishedRaw: string | null }>;
             error?: string; latencyMs: number }> {
  const t0 = Date.now();
  const log = (r: any) => {
    db.prepare(`INSERT INTO source_tests
      (source_id,url,started_at,latency_ms,outcome,http_code,bytes,parsed_count,parser,sample_json,error,actor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(o.sourceId ?? null, o.url, nowIso(), Date.now() - t0, r.outcome,
           r.httpCode ?? null, r.bytes ?? null, r.parsedCount ?? null, o.parser,
           r.sample?.length ? JSON.stringify(r.sample) : null, r.error ?? null, o.actor ?? 'owner');
    return { ...r, latencyMs: Date.now() - t0 };
  };

  const safe = await checkUrlSafe(o.url);
  if (!safe.ok) return log({ ok: false, outcome: 'blocked', sample: [], error: safe.reason });

  if (!PARSERS.includes(o.parser as any))
    return log({ ok: false, outcome: 'blocked', sample: [], error: `未知解析器 ${o.parser}` });

  let res;
  try {
    res = await fetchSmart(safe.url, { timeoutMs: 20000, maxBytes: 5 * 1024 * 1024,
      userAgent: 'BriefingBot/1.0 (+personal daily digest; source test)' });
  } catch (e: any) {
    return log({ ok: false, outcome: 'fetch_failed', sample: [], error: String(e?.message ?? e).slice(0, 300) });
  }
  if (res.outcome !== 'ok' || !res.body)
    return log({ ok: false, outcome: 'fetch_failed', httpCode: res.httpCode, sample: [],
                 error: res.errorMessage ?? res.outcome });

  try {
    const ch = /telegram\/channel\/([^/?]+)|t\.me\/s\/([^/?]+)/.exec(safe.url);
    const items = parseBy(o.parser, res.body, { channel: ch?.[1] ?? ch?.[2] });
    const sample = items.slice(0, 3).map(i => ({
      title: String(i.title ?? '').slice(0, 90), link: i.link, publishedRaw: i.publishedRaw }));
    if (!items.length)
      return log({ ok: false, outcome: 'parse_failed', httpCode: res.httpCode, bytes: res.bytes,
                   parsedCount: 0, sample: [], error: '抓取成功但解析出 0 条 —— 解析器可能不匹配' });
    return log({ ok: true, outcome: 'ok', httpCode: res.httpCode, bytes: res.bytes,
                 parsedCount: items.length, sample });
  } catch (e: any) {
    return log({ ok: false, outcome: 'parse_failed', httpCode: res.httpCode, bytes: res.bytes,
                 sample: [], error: String(e?.message ?? e).slice(0, 300) });
  }
}

/** 新增来源（FR-001）。新增前强制通过测试抓取，避免加进去一个死链。 */
export async function addSource(db: DB, o: SourceInput & { skipTest?: boolean }) {
  const id = String(o.id ?? '').trim().toLowerCase();
  if (!SOURCE_ID.test(id))
    throw new ActionError(400, 'ID 需为 2–32 位小写字母/数字/下划线，且以字母开头');
  if (db.prepare('SELECT 1 FROM sources WHERE id=?').get(id))
    throw new ActionError(409, `来源 ID「${id}」已存在`);
  const name = String(o.name ?? '').trim();
  if (name.length < 2) throw new ActionError(400, '名称至少 2 个字');
  if (!PARSERS.includes(o.parser as any)) throw new ActionError(400, '未知解析器');
  if (!CATEGORIES.includes(o.category as any)) throw new ActionError(400, '未知分类');
  if (!TIERS.includes(o.tier as any)) throw new ActionError(400, '未知采集档');

  const safe = await checkUrlSafe(o.url);
  if (!safe.ok) throw new ActionError(400, `URL 不可用：${safe.reason}`);

  if (!o.skipTest) {
    const t = await testSource(db, { url: safe.url, parser: o.parser, actor: o.actor });
    if (!t.ok) throw new ActionError(400, `测试抓取未通过：${t.error} —— 修正后再添加，或勾选「跳过测试」强制添加`);
  }

  const cfg = {
    id, name, display_name: name, category: o.category,
    host_group: 'direct', harvest_tier: o.tier, enabled: true,
    priority: o.priority ?? 5,
    require_fulltext: !!o.requireFulltext,
    mandatory_retention: !!o.mandatoryRetention,
    endpoints: [{ url: safe.url, parser: o.parser, priority: 1 }],
  };
  const now = nowIso();

  db.transaction(() => {
    // 主页默认取 URL 的 origin —— RSS 地址本身不适合给人点
    const siteUrl = (() => { try { return new URL(safe.url).origin; } catch { return null; } })();
    db.prepare(`INSERT INTO sources (id,name,display_name,category,host_group,harvest_tier,
      enabled,priority,mandatory_retention,require_fulltext,config_json,source_version,
      managed_by,site_url,created_by,created_at,updated_at)
      VALUES (?,?,?,?,'direct',?,1,?,?,?,?,0,'admin',?,?,?,?)`)
      .run(id, name, name, o.category, o.tier, o.priority ?? 5,
           o.mandatoryRetention ? 1 : 0, o.requireFulltext ? 1 : 0,
           JSON.stringify(cfg), siteUrl, o.actor ?? 'owner', now, now);
    db.prepare(`INSERT INTO source_endpoints (source_id,priority,url,parser,enabled)
      VALUES (?,1,?,?,1)`).run(id, safe.url, o.parser);
    audit(db, { entityType: 'source', entityId: id, action: 'source_added',
      payload: { name, url: safe.url, parser: o.parser, category: o.category,
                 tier: o.tier, actor: o.actor ?? 'owner', reason: `新增来源 ${name}` } });
  })();
  return { ok: true as const, id };
}

/** 删除来源。只允许删后台新增的 —— 配置来源应改 sources.yaml。 */
export function deleteSource(db: DB, id: string, reason: string, actor = 'owner') {
  const r = requireReason(reason);
  const s = db.prepare('SELECT id, managed_by, name FROM sources WHERE id=?').get(id) as any;
  if (!s) throw new ActionError(404, '来源不存在');
  if (s.managed_by !== 'admin')
    throw new ActionError(400, '该来源来自 config/sources.yaml，请改配置文件后执行同步；后台只能删除自己新增的来源');

  const items = (db.prepare('SELECT count(*) c FROM feed_items WHERE source_id=?').get(id) as any).c;
  db.transaction(() => {
    // 已抓到的内容不删 —— 审计要求可追溯（PRD 13.3）。只停用并标记。
    db.prepare(`UPDATE sources SET enabled=0, health='disabled', updated_at=? WHERE id=?`)
      .run(nowIso(), id);
    db.prepare(`UPDATE source_endpoints SET enabled=0 WHERE source_id=?`).run(id);
    db.prepare(`INSERT INTO manual_overrides (target_type,target_id,action,reason,scope,actor,created_at)
      VALUES ('source',?,'delete',?,'permanent',?,?)`).run(id, r, actor, nowIso());
    audit(db, { entityType: 'source', entityId: id, action: 'source_deleted',
      payload: { reason: r, actor, name: s.name, retainedItems: items } });
  })();
  return { ok: true as const, retainedItems: items };
}
