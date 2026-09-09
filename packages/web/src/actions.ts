import type { DB } from '../../db/src/index.ts';
import { nowIso } from '../../db/src/index.ts';
import { checkUrlSafe } from '../../connectors/src/ssrf.ts';
import { fetchSmart } from '../../connectors/src/fetch.ts';
import { parseBy } from '../../connectors/src/parsers.ts';
import { createProvider } from '../../ai/src/registry.ts';
import { runSourceProfiler } from '../../ai/src/source-profiler.ts';
import { resolveSecret, resolveSettings } from './secrets.ts';
import { sha256 } from '../../db/src/index.ts';

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

export type OverrideAction = 'include' | 'retain' | 'filter' | 'reclassify' | 'lock';

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
    case 'retain':
      decision = 'retain';
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
      filter_rule_id=CASE WHEN ? IN ('include','retain') THEN NULL ELSE filter_rule_id END,
      filter_reason=CASE WHEN ?='filter' THEN ? WHEN ? IN ('include','retain') THEN NULL ELSE filter_reason END
      WHERE id=?`)
      .run(decision, mandatoryClass, section, o.action, o.action, `人工：${reason}`,
           o.action, o.candidateId);

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
    if(enabled && !s.enabled) db.prepare('UPDATE allnet_subscriptions SET briefing_enabled_since=? WHERE source_id=?').run(nowIso(),id);
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

/** 修改后台展示分组；该字段不参与日报内容分类。 */
export function updateSourceGroup(db: DB, id: string, sourceGroup: string, reason: string, actor = 'owner') {
  const r = requireReason(reason);
  if (!SOURCE_GROUPS.includes(sourceGroup as any)) throw new ActionError(400, '未知来源分组');
  const s = db.prepare('SELECT id,source_group FROM sources WHERE id=?').get(id) as any;
  if (!s) throw new ActionError(404, '来源不存在');
  if (s.source_group === sourceGroup) return { ok: true as const, sourceGroup };
  const now = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE sources SET source_group=?,updated_at=? WHERE id=?').run(sourceGroup, now, id);
    audit(db, { entityType: 'source', entityId: id, action: 'source_group_updated',
      payload: { reason: r, from: s.source_group, to: sourceGroup, actor } });
  })();
  return { ok: true as const, sourceGroup };
}

/**
 * 修改来源的主订阅地址。新地址必须先通过与“仅测试”相同的安全与解析探测，
 * 避免一次误改直接让生产采集断流。人工覆盖使用 source_endpoint:<id>:<priority>
 * 留痕，配置同步器据此保留后台修改。
 */
export async function updateSourceUrl(
  db: DB,
  o: { sourceId: string; url: string; reason: string; priority?: number; actor?: string },
  probe: typeof testSource = testSource,
) {
  const reason = requireReason(o.reason);
  const priority = Number.isInteger(o.priority) && Number(o.priority) > 0 ? Number(o.priority) : 1;
  const ep = db.prepare(`SELECT e.id,e.source_id,e.priority,e.url,e.parser,s.site_url
    FROM source_endpoints e JOIN sources s ON s.id=e.source_id
    WHERE e.source_id=? AND e.priority=?`).get(o.sourceId, priority) as any;
  if (!ep) throw new ActionError(404, '来源或主订阅地址不存在');

  const rawUrl = String(o.url ?? '').trim();
  if (!rawUrl) throw new ActionError(400, '订阅 URL 不能为空');
  let normalized: string;
  try { normalized = new URL(rawUrl).toString(); }
  catch { throw new ActionError(400, '订阅 URL 格式无效'); }
  if (normalized === ep.url) throw new ActionError(409, '新 URL 与当前 URL 相同');

  const tested = await probe(db, { url: normalized, parser: ep.parser,
    sourceId: o.sourceId, actor: o.actor ?? 'owner' });
  if (!tested.ok)
    throw new ActionError(400, `新 URL 测试失败（${tested.outcome}）：${tested.error ?? '未知错误'}`);

  const now = nowIso();
  const oldOrigin = (() => { try { return new URL(ep.url).origin; } catch { return null; } })();
  const newOrigin = new URL(normalized).origin;
  db.transaction(() => {
    db.prepare(`UPDATE source_endpoints SET url=?,etag=NULL,last_modified=NULL WHERE id=?`)
      .run(normalized, ep.id);
    db.prepare(`UPDATE sources SET
      site_url=CASE WHEN site_url IS NULL OR site_url=? THEN ? ELSE site_url END,
      health='unknown',consecutive_failures=0,last_error=NULL,last_http_code=NULL,updated_at=?
      WHERE id=?`).run(oldOrigin, newOrigin, now, o.sourceId);
    db.prepare(`INSERT INTO manual_overrides
      (target_type,target_id,action,reason,scope,actor,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run('source_endpoint', `${o.sourceId}:${priority}`, 'edit_url', reason,
        'permanent', o.actor ?? 'owner', now);
    audit(db, { entityType: 'source_endpoint', entityId: `${o.sourceId}:${priority}`,
      action: 'source_url_updated', payload: { reason, oldUrl: ep.url, newUrl: normalized,
        parser: ep.parser, parsedCount: tested.parsedCount ?? null, actor: o.actor ?? 'owner' } });
  })();
  return { ok: true as const, sourceId: o.sourceId, priority, oldUrl: ep.url,
    newUrl: normalized, parsedCount: tested.parsedCount ?? 0 };
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

export const PARSERS = ['rss', 'atom', 'telegram_web', 'deepseek_page', 'openai_release_notes_page'] as const;
export const CATEGORIES = ['ai', 'developer', 'tech', 'article', 'society', 'forum'] as const;
export const TIERS = ['ranking_feed', 'standard', 'official_changelog', 'slow'] as const;
export const SOURCE_GROUPS = ['unclassified', 'openai', 'claude', 'google', 'deepseek', 'cloudflare', 'github', 'hermes', 'meituan', 'zhihu', 'weibo', 'baidu'] as const;

export type SourceInput = {
  id: string; name: string; url: string; parser: string;
  category: string; tier: string; priority?: number;
  sourceGroup?: string;
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
): Promise<{ ok: boolean; outcome: string; httpCode?: number; contentType?: string; latestItemAt?: string | null; bytes?: number;
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
    const sample = items.slice(0, 20).map((i, index) => ({
      sampleId: `sample-${index + 1}`,
      title: String(i.title ?? '').slice(0, 90), link: i.link, publishedRaw: i.publishedRaw }));
    const latestItemAt = items.map(i => i.publishedRaw).filter(Boolean).sort().at(-1) ?? null;
    if (!items.length)
      return log({ ok: false, outcome: 'parse_failed', httpCode: res.httpCode, bytes: res.bytes,
                   parsedCount: 0, sample: [], error: '抓取成功但解析出 0 条 —— 解析器可能不匹配' });
    return log({ ok: true, outcome: 'ok', httpCode: res.httpCode, contentType: (res as any).contentType ?? null,
                 latestItemAt, bytes: res.bytes, parsedCount: items.length, sample });
  } catch (e: any) {
    return log({ ok: false, outcome: 'parse_failed', httpCode: res.httpCode, bytes: res.bytes,
                 sample: [], error: String(e?.message ?? e).slice(0, 300) });
  }
}

function sourceProfilerConfig() {
  const s = resolveSettings();
  const provider = (s.sourceProfilerProvider ?? 'mock') as any;
  const secretName = s.sourceProfilerCredentialRef ?? 'SOURCE_PROFILER_API_KEY';
  const apiKey = provider === 'mock' ? undefined : resolveSecret(secretName as any);
  return { provider, model: s.sourceProfilerModel ?? 'mock-profiler', apiKey,
    baseUrl: s.sourceProfilerBaseUrl, timeoutMs: Number(s.sourceProfilerTimeoutMs ?? 30000) };
}

export function ensureProfilerProfile(db: DB) {
  const s = resolveSettings();
  const cfg = sourceProfilerConfig();
  const versionHash = sha256(JSON.stringify({ ...cfg, temperature: s.sourceProfilerTemperature,
    reasoning_effort: s.sourceProfilerReasoningEffort, max_input_chars: s.sourceProfilerMaxInputChars,
    max_output_tokens: s.sourceProfilerMaxOutputTokens, retry_policy: s.sourceProfilerRetryPolicy,
    fallback_profile: s.sourceProfilerFallbackProfile })).slice(0, 12);
  const existing = db.prepare(`SELECT * FROM ai_model_profiles WHERE purpose='source_profiler'
    ORDER BY config_version DESC LIMIT 1`).get() as any;
  const existingParams = (() => { try { return JSON.parse(existing?.params_json ?? '{}'); } catch { return {}; } })();
  const enabled = s.sourceProfilerEnabled === 'false' ? 0 : 1;
  if (existing?.model_id === cfg.model && existing?.provider === cfg.provider && existing?.base_url === (cfg.baseUrl ?? null)
      && existing?.enabled === enabled && existingParams.config_hash === versionHash) return existing;
  const now = nowIso();
  const next = Number(existing?.config_version ?? 0) + 1;
  db.prepare(`INSERT INTO ai_model_profiles
    (purpose,provider,base_url,model_id,credential_secret_ref,params_json,fallback_profile,enabled,config_version,created_at,updated_at)
    VALUES ('source_profiler',?,?,?,?,?,?,?,?,?,?)`).run(cfg.provider, cfg.baseUrl ?? null, cfg.model,
      s.sourceProfilerCredentialRef ?? 'SOURCE_PROFILER_API_KEY', JSON.stringify({ temperature: s.sourceProfilerTemperature,
      reasoning_effort: s.sourceProfilerReasoningEffort, max_input_chars: s.sourceProfilerMaxInputChars,
      max_output_tokens: s.sourceProfilerMaxOutputTokens, retry_policy: s.sourceProfilerRetryPolicy, config_hash: versionHash }),
      s.sourceProfilerFallbackProfile ?? null, enabled, next, now, now);
  return db.prepare(`SELECT * FROM ai_model_profiles WHERE purpose='source_profiler' AND config_version=?`).get(next) as any;
}

export async function createSourceProposal(db: DB, o: SourceInput & { skipTest?: boolean }) {
  const id = String(o.id ?? '').trim().toLowerCase();
  if (!SOURCE_ID.test(id)) throw new ActionError(400, 'ID 需为 2–32 位小写字母/数字/下划线，且以字母开头');
  if (db.prepare('SELECT 1 FROM sources WHERE id=?').get(id)) throw new ActionError(409, `来源 ID「${id}」已存在`);
  const name = String(o.name ?? '').trim();
  if (name.length < 2) throw new ActionError(400, '名称至少 2 个字');
  if (!PARSERS.includes(o.parser as any)) throw new ActionError(400, '未知解析器');
  if (!CATEGORIES.includes(o.category as any)) throw new ActionError(400, '未知分类');
  const sourceGroup = String(o.sourceGroup ?? 'unclassified');
  if (!SOURCE_GROUPS.includes(sourceGroup as any)) throw new ActionError(400, '未知来源分组');
  if (!TIERS.includes(o.tier as any)) throw new ActionError(400, '未知采集档');
  const safe = await checkUrlSafe(o.url);
  if (!safe.ok) throw new ActionError(400, `URL 不可用：${safe.reason}`);
  const t = await testSource(db, { url: safe.url, parser: o.parser, actor: o.actor });
  if (!t.ok) throw new ActionError(400, `探测失败（${t.outcome}）：${t.error ?? '未知错误'}`);
  const profile = ensureProfilerProfile(db);
  let analysis: any;
  let error: string | null = null;
  try {
    if (!profile.enabled) throw new Error('Source Profiler 模型配置未启用');
    const provider = await createProvider(sourceProfilerConfig());
    const input = { url: safe.url, parser: o.parser, name,
      metadata: { http_status: t.httpCode, content_type: t.contentType, parsed_count: t.parsedCount,
        latest_item_at: t.latestItemAt, bytes: t.bytes }, samples: t.sample };
    try { analysis = await runSourceProfiler(provider, input); }
    catch (first: any) {
      const fallback = resolveSettings().sourceProfilerFallbackProfile;
      if (!fallback) throw first;
      const fallbackProvider = await createProvider({ provider: 'mock', model: fallback, strictness: 'strict' });
      analysis = await runSourceProfiler(fallbackProvider, input);
      analysis.fallback_used = fallback;
    }
  } catch (e: any) { error = String(e?.message ?? e).slice(0, 500); }
  const now = nowIso();
  let proposalId = 0;
  db.transaction(() => {
    const siteUrl = (() => { try { return new URL(safe.url).origin; } catch { return null; } })();
    db.prepare(`INSERT INTO sources (id,name,display_name,category,host_group,harvest_tier,enabled,priority,
      mandatory_retention,require_fulltext,config_json,source_version,managed_by,site_url,created_by,created_at,updated_at,
      onboarding_status,rule_profile,config_version,timeout_ms,max_response_bytes)
      VALUES (?,?,?,?,?, ?,0,?,?,?,?,0,'admin',?,?,?,? ,?,?,1,20000,5242880)`).run(
        id, name, name, o.category, 'direct', o.tier, o.priority ?? 5, o.mandatoryRetention ? 1 : 0,
        o.requireFulltext ? 1 : 0, JSON.stringify({ id, name, category: o.category, harvest_tier: o.tier, enabled: false }),
        siteUrl, o.actor ?? 'owner', now, now, error ? 'AI_ANALYSIS_FAILED' : 'HUMAN_REVIEW', analysis?.recommended_rule_profile ?? 'default');
    db.prepare(`INSERT INTO source_endpoints (source_id,priority,url,parser,enabled) VALUES (?,1,?,?,0)`).run(id, safe.url, o.parser);
    db.prepare('UPDATE sources SET source_group=? WHERE id=?').run(sourceGroup, id);
    const ins = db.prepare(`INSERT INTO source_onboarding_proposals
      (source_id,source_url,source_name,parser,sample_json,source_profile_json,evidence_sample_ids,rule_diff_json,
       capability_gap_json,model_profile_id,model_config_version,request_id,confidence,status,error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, safe.url, name, o.parser, JSON.stringify(t.sample),
      analysis ? JSON.stringify(analysis) : null, JSON.stringify(analysis?.evidence_sample_ids ?? t.sample.map((x: any) => x.sampleId)),
      analysis ? JSON.stringify(analysis.proposed_rule_diff ?? []) : null, analysis?.capability_gap ? JSON.stringify(analysis.capability_gap) : null,
      profile.id, profile.config_version, analysis?.responseId ?? null, analysis?.confidence ?? null,
      error ? 'AI_ANALYSIS_FAILED' : 'HUMAN_REVIEW', error, now, now);
    proposalId = Number(ins.lastInsertRowid);
    audit(db, { entityType: 'source_onboarding_proposal', entityId: String(proposalId), action: 'source_profiled',
      payload: { source_id: id, status: error ? 'AI_ANALYSIS_FAILED' : 'HUMAN_REVIEW', model_profile_id: profile.id,
        model_config_version: profile.config_version, error, actor: o.actor ?? 'owner' } });
  })();
  if (error) throw new ActionError(502, `来源已保存为待分析提案，但 Source Profiler 失败：${error}`);
  return { ok: true as const, id, proposalId, status: 'HUMAN_REVIEW', confidence: analysis.confidence };
}

export function approveSourceProposal(db: DB, proposalId: number, actor = 'owner') {
  const p = db.prepare('SELECT * FROM source_onboarding_proposals WHERE id=?').get(proposalId) as any;
  if (!p) throw new ActionError(404, '来源提案不存在');
  if (!['HUMAN_REVIEW','AI_ANALYZED'].includes(p.status)) throw new ActionError(409, `提案当前状态为 ${p.status}，不能审批`);
  const now = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE source_onboarding_proposals SET status='APPROVED_CONFIG',reviewer=?,reviewed_at=?,approved_version=1,updated_at=? WHERE id=?`).run(actor, now, now, proposalId);
    db.prepare(`UPDATE sources SET enabled=1,onboarding_status='OBSERVATION',config_version=config_version+1,
      observation_until=datetime('now','+3 days'),updated_at=? WHERE id=?`).run(now, p.source_id);
    db.prepare('UPDATE source_endpoints SET enabled=1 WHERE source_id=?').run(p.source_id);
    audit(db, { entityType: 'source_onboarding_proposal', entityId: String(proposalId), action: 'source_approved', payload: { source_id: p.source_id, actor, rule_diff: JSON.parse(p.rule_diff_json ?? '[]') } });
  })();
  return { ok: true as const, sourceId: p.source_id, status: 'OBSERVATION' };
}

export function rejectSourceProposal(db: DB, proposalId: number, reason: string, actor = 'owner') {
  const r = requireReason(reason); const p = db.prepare('SELECT * FROM source_onboarding_proposals WHERE id=?').get(proposalId) as any;
  if (!p) throw new ActionError(404, '来源提案不存在');
  db.transaction(() => { db.prepare(`UPDATE source_onboarding_proposals SET status='REJECTED',reviewer=?,reviewed_at=?,updated_at=?,error=? WHERE id=?`).run(actor, nowIso(), nowIso(), r, proposalId); db.prepare(`UPDATE sources SET enabled=0,onboarding_status='REJECTED',updated_at=? WHERE id=?`).run(nowIso(), p.source_id); db.prepare('UPDATE source_endpoints SET enabled=0 WHERE source_id=?').run(p.source_id); audit(db, { entityType: 'source_onboarding_proposal', entityId: String(proposalId), action: 'source_rejected', payload: { reason: r, actor } }); })();
  return { ok: true as const, status: 'REJECTED' };
}

/** 新增来源（FR-001）。新增前强制通过测试抓取，避免加进去一个死链。 */
export async function addSource(db: DB, o: SourceInput & { skipTest?: boolean }) {
  return createSourceProposal(db, o);
}

/** 删除来源。只允许删后台新增的 —— 配置来源应改 sources.yaml。 */
export function deleteSource(db: DB, id: string, reason: string, actor = 'owner') {
  const r = requireReason(reason);
  const s = db.prepare('SELECT id, managed_by, name FROM sources WHERE id=?').get(id) as any;
  if (!s) throw new ActionError(404, '来源不存在');
  if (s.managed_by !== 'admin')
    throw new ActionError(400, '该来源来自 config/sources.yaml，请改配置文件后执行同步；后台只能删除自己新增的来源');

  if(db.prepare('SELECT 1 FROM allnet_subscriptions WHERE source_id=?').get(id))
    throw new ActionError(400,'全网热点订阅请分别管理参与日报、采集和令牌，不支持从来源页删除');
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
