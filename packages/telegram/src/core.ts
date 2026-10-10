import { randomBytes, createHash } from 'node:crypto';
import type { TelegramDB } from './db.ts';

export type SourceType = 'normal' | 'url';
export class TelegramError extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; this.name = 'TelegramError'; }
}
export const nowIso = () => new Date().toISOString();
export const token256 = () => randomBytes(32).toString('hex');

const USERNAME = /^[A-Za-z0-9_]{5,32}$/;
export type TelegramReference =
  | { kind: 'public'; canonical: string; resolveAs: string }
  | { kind: 'private_message'; canonical: string; resolveAs: number }
  | { kind: 'invite'; canonical: string; resolveAs: string };

/** 语法解析不触发 join；worker 对邀请链接只在现有 dialogs 中确认成员关系。 */
export function normalizeTelegramReference(raw: string): TelegramReference {
  const value = raw.trim();
  if (!value) throw new TelegramError(400, '群组地址不能为空');
  if (value.startsWith('@')) {
    if (!USERNAME.test(value.slice(1))) throw new TelegramError(400, 'Telegram 用户名格式无效');
    const u = value.slice(1).toLowerCase();
    return { kind: 'public', canonical: `@${u}`, resolveAs: `@${u}` };
  }
  let parsed: URL;
  try { parsed = new URL(value.includes('://') ? value : `https://${value}`); }
  catch { throw new TelegramError(400, 'Telegram 地址格式无效'); }
  if (!['http:','https:'].includes(parsed.protocol) || !['t.me','www.t.me','telegram.me','www.telegram.me'].includes(parsed.hostname.toLowerCase()))
    throw new TelegramError(400, '只接受 Telegram 的 HTTP/HTTPS 地址');
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash)
    throw new TelegramError(400, 'Telegram 地址不能包含凭据、端口、查询或片段');
  const p = parsed.pathname.split('/').filter(Boolean);
  if (p[0]?.toLowerCase() === 's') p.shift();
  if (p[0]?.toLowerCase() === 'c' && /^\d+$/.test(p[1] ?? '') && /^\d+$/.test(p[2] ?? '') && p.length === 3) {
    const internal = Number(p[1]);
    if (!Number.isSafeInteger(internal)) throw new TelegramError(400, '私有群组 ID 无效');
    return { kind: 'private_message', canonical: `t.me/c/${internal}`, resolveAs: -1_000_000_000_000 - internal };
  }
  const invite = (p.length === 1 && p[0]!.startsWith('+')) ||
    (p.length === 2 && p[0]!.toLowerCase() === 'joinchat' && !!p[1]);
  if (invite) return { kind: 'invite', canonical: `t.me/${p.join('/')}`, resolveAs: `https://t.me/${p.join('/')}` };
  if (p.length !== 1 || !USERNAME.test(p[0]!)) throw new TelegramError(400, 'Telegram 地址必须指向群组、频道或一条 t.me/c 消息');
  const u = p[0]!.toLowerCase();
  return { kind: 'public', canonical: `@${u}`, resolveAs: `@${u}` };
}

const URLISH = /https?:\/\/[^\s<>"'，。；：！？、]+|(?<![@\w])(?:www\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})){1,}(?:\/[^\s<>"'，。；：！？、]*)?/gi;
const BARE_HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{2,59})$/i;
export function extractUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URLISH)) {
    let candidate = m[0].replace(/[.,;:!?，。；：！？、)\]}》】'"。]+$/g, '');
    const explicit = /^https?:\/\//i.test(candidate);
    if (!explicit) candidate = `https://${candidate}`;
    try {
      const u = new URL(candidate);
      if (!['http:','https:'].includes(u.protocol) || !u.hostname || (!explicit && !BARE_HOST.test(u.hostname))) continue;
      u.hostname = u.hostname.toLowerCase();
      if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
      u.hash = '';
      out.add(u.toString());
    } catch { /* 忽略伪 URL */ }
  }
  return [...out];
}

function audit(db: TelegramDB, type: string, id: string, action: string, payload: unknown = {}) {
  db.prepare('INSERT INTO telegram_audit_events(entity_type,entity_id,action,payload_json,created_at) VALUES(?,?,?,?,?)')
    .run(type, id, action, JSON.stringify(payload), nowIso());
}

export function addTelegramSource(db: TelegramDB, input: { reference: string; displayName?: string; sourceType: SourceType }) {
  if (!['normal','url'].includes(input.sourceType)) throw new TelegramError(400, '来源类型无效');
  const ref = normalizeTelegramReference(input.reference);
  const now = nowIso();
  const result = db.prepare(`INSERT INTO telegram_sources
    (reference,display_name,source_type,status,enabled,validation_requested_at,created_at,updated_at)
    VALUES(?,?,?,'pending',0,?,?,?)`).run(ref.canonical, input.displayName?.trim() || null, input.sourceType, now, now, now);
  audit(db, 'source', String(result.lastInsertRowid), 'source_added', { referenceKind: ref.kind, sourceType: input.sourceType });
  return { id: Number(result.lastInsertRowid), status: 'pending' as const };
}

export function retryTelegramSource(db: TelegramDB, id: number) {
  const now = nowIso();
  const r = db.prepare(`UPDATE telegram_sources SET status='pending',enabled=0,last_error=NULL,
    validation_requested_at=?,updated_at=? WHERE id=?`).run(now, now, id);
  if (!r.changes) throw new TelegramError(404, 'Telegram 来源不存在');
  audit(db, 'source', String(id), 'validation_retried');
}

/** 显示名用于 RSS 标题和汇总里的来源频道；留空则回退为 Telegram 上的频道标题。 */
export function renameTelegramSource(db: TelegramDB, id: number, displayName: string) {
  const name = displayName.trim();
  if (name.length > 80) throw new TelegramError(400, '显示名不能超过 80 个字符');
  const r = db.prepare('UPDATE telegram_sources SET display_name=?,updated_at=? WHERE id=?').run(name || null, nowIso(), id);
  if (!r.changes) throw new TelegramError(404, 'Telegram 来源不存在');
  audit(db, 'source', String(id), 'source_renamed', { displayName: name || null });
}

export function toggleTelegramSource(db: TelegramDB, id: number, enabled: boolean) {
  const row = db.prepare('SELECT status FROM telegram_sources WHERE id=?').get(id) as any;
  if (!row) throw new TelegramError(404, 'Telegram 来源不存在');
  if (enabled && row.status !== 'active' && row.status !== 'disabled') throw new TelegramError(409, '来源尚未验证成功');
  db.prepare(`UPDATE telegram_sources SET enabled=?,status=?,updated_at=? WHERE id=?`)
    .run(enabled ? 1 : 0, enabled ? 'active' : 'disabled', nowIso(), id);
  audit(db, 'source', String(id), enabled ? 'source_enabled' : 'source_disabled');
}

export function rotateSourceToken(db: TelegramDB, id: number, revoke = false): string | null {
  const row = db.prepare("SELECT source_type FROM telegram_sources WHERE id=?").get(id) as any;
  if (!row) throw new TelegramError(404, 'Telegram 来源不存在');
  if (row.source_type !== 'normal') throw new TelegramError(400, 'URL 渠道不提供 RSS');
  const token = revoke ? null : token256();
  db.prepare('UPDATE telegram_sources SET rss_token=?,updated_at=? WHERE id=?').run(token, nowIso(), id);
  audit(db, 'source', String(id), revoke ? 'rss_token_revoked' : 'rss_token_rotated');
  return token;
}

export function rotateAllToken(db: TelegramDB, revoke = false): string | null {
  const token = revoke ? null : token256();
  db.prepare('UPDATE telegram_settings SET all_rss_token=?,updated_at=? WHERE singleton=1').run(token, nowIso());
  audit(db, 'settings', 'all_rss', revoke ? 'rss_token_revoked' : 'rss_token_rotated');
  return token;
}

export function updateTelegramSettings(db: TelegramDB, input: Record<string, unknown>) {
  const timezone = String(input.timezone ?? 'Asia/Shanghai').trim();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new TelegramError(400, '时区无效'); }
  const schedule = String(input.schedule ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (!schedule.length || schedule.some(x => !/^([01]\d|2[0-3]):[0-5]\d$/.test(x))) throw new TelegramError(400, '时段必须是逗号分隔的 HH:MM');
  const sorted = [...new Set(schedule)].sort();
  const provider=String(input.provider ?? 'openai_compatible');
  if(!['mock','openai','openai_compatible','deepseek','qwen','anthropic','gemini'].includes(provider)) throw new TelegramError(400,'供应商无效');
  const credentialRef=String(input.credentialRef ?? 'OPENAI_COMPAT_API_KEY');
  if(!['OPENAI_COMPAT_API_KEY','OPENAI_API_KEY','DEEPSEEK_API_KEY','DASHSCOPE_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY'].includes(credentialRef)) throw new TelegramError(400,'密钥引用无效');
  const previous = db.prepare('SELECT prompt_rules FROM telegram_settings WHERE singleton=1').get() as any;
  const prompt = String(input.promptRules ?? '').trim().slice(0, 8000);
  db.prepare(`UPDATE telegram_settings SET timezone=?,schedule_json=?,provider=?,model=?,base_url=?,credential_ref=?,prompt_rules=?,
    prompt_version=prompt_version+?,updated_at=? WHERE singleton=1`).run(timezone, JSON.stringify(sorted), provider,
      String(input.model ?? '').trim(), String(input.baseUrl ?? '').trim() || null, credentialRef, prompt,
      previous?.prompt_rules === prompt ? 0 : 1, nowIso());
  audit(db, 'settings', 'global', 'settings_updated', { timezone, schedule: sorted, provider: input.provider, model: input.model,
    credentialRef: input.credentialRef, promptChanged: previous?.prompt_rules !== prompt });
}

const intIn = (v: unknown, min: number, max: number, label: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new TelegramError(400, `${label}必须是 ${min}–${max} 之间的整数`);
  return n;
};

/** 识别器每分钟处理 1 张（brief-telegram-vision.timer），上限超过 1440 没有意义。 */
export function setVisionDailyLimit(db: TelegramDB, limit: unknown): void {
  const n = intIn(limit, 1, 1440, '每日上限');
  const before = (db.prepare('SELECT vision_daily_limit v FROM telegram_settings WHERE singleton=1').get() as any)?.v;
  db.prepare('UPDATE telegram_settings SET vision_daily_limit=?,updated_at=? WHERE singleton=1').run(n, nowIso());
  audit(db, 'settings', 'vision', 'vision_daily_limit_updated', { from: before, to: n });
}

export function updateTelegramRetention(db: TelegramDB, input: { keepForever: boolean; rawDays: unknown; summaryDays: unknown }): void {
  const raw = intIn(input.rawDays, 1, 365, '消息保留天数');
  const summary = intIn(input.summaryDays, 1, 365, '总结保留天数');
  db.prepare(`UPDATE telegram_settings SET keep_messages_forever=?,raw_retention_days=?,summary_retention_days=?,updated_at=? WHERE singleton=1`)
    .run(input.keepForever ? 1 : 0, raw, summary, nowIso());
  audit(db, 'settings', 'retention', 'retention_updated', { keepForever: input.keepForever, rawDays: raw, summaryDays: summary });
}

export function resumeVisionQueue(db: TelegramDB): void {
  db.prepare(`UPDATE telegram_settings SET vision_paused=0,vision_pause_reason=NULL,updated_at=? WHERE singleton=1`)
    .run(nowIso());
  audit(db, 'settings', 'vision', 'vision_queue_resumed');
}

export type SummaryShape = { topics: string[]; important: string[]; viewpoints: string[]; sources: Array<{messageId:number;time:string}>; uncertainty: string[] };
const INLINE_MESSAGE_REFERENCES = /[（(]\s*消息(?:\s*ID)?\s*[:：]?\s*#?\d+(?:\s*[,，、;；]\s*#?\d+)*\s*[)）]/giu;
/** 展示内容不暴露内部消息定位信息；结构化 sources 字段仍完整保留用于校验和审计。 */
export function stripMessageReferences(value: unknown): string {
  return String(value ?? '').replace(INLINE_MESSAGE_REFERENCES, '').trim();
}
/**
 * 群管理机器人的模板消息（入群验证、欢迎、封禁通知、机器人自我介绍或命令回复）不是群内讨论，
 * 送去总结只会产生「入群验证过期可能导致永久封禁」这类无用要点。只匹配机器人模板的固定措辞，
 * 群友讨论「验证码」「身份验证」「账号被封」不受影响；被封禁通知只认机器人打码的用户名（H***e）。
 */
const GROUP_ADMIN_NOTICE = [
  /未能完成入群验证|请完成入群验证|入群验证(?:已)?(?:超时|过期|失败)|由于验证已过期/u,
  /^\s*欢迎\s*\S{0,40}\s*加入(?:本)?群(?:组|聊)?\s*[!！。]/u,
  /^\s*(?:你好[，,]?\s*)?欢迎使用\s*[\w\s-]{0,30}bot/iu,
  /找不到要封禁的(?:频道|用户)|无法通过用户名封禁用户/u,
  /^\s*\S*\*{2,}\S*\s.*已被(?:永久)?(?:封禁|禁言|踢出|移出)/u,
];
export function isGroupAdminNotice(text: unknown): boolean {
  const value = String(text ?? '');
  return GROUP_ADMIN_NOTICE.some(re => re.test(value));
}

const VIEWPOINT_LEAD_INS =/(?:(?:有人|群友)(?:提出|认为|表示|提到|指出|建议|质疑)|消息中提到)[：:，,]?\s*/gu;
export function cleanViewpoint(value: unknown): string {
  return stripMessageReferences(value).replace(VIEWPOINT_LEAD_INS, '').trim();
}
export function consolidateViewpoints(values: unknown[]): string {
  const clean = [...new Set(values.map(cleanViewpoint).filter(Boolean))];
  return clean.join(' ').replace(/\s+/g, ' ').trim();
}
export function validateSummary(value: unknown): SummaryShape {
  const v = value as any;
  if (!v || !['topics','important','viewpoints','sources','uncertainty'].every(k => Array.isArray(v[k]))) throw new TelegramError(502, 'AI 总结结构无效');
  if (['topics','important','viewpoints','uncertainty'].some(k => v[k].some((x:unknown)=>typeof x!=='string'))) throw new TelegramError(502, 'AI 总结文本结构无效');
  if (v.viewpoints.length > 1) throw new TelegramError(502, 'AI 主要观点必须合并为一个段落');
  if (v.sources.some((s: any) => !Number.isInteger(s?.messageId) || typeof s?.time !== 'string')) throw new TelegramError(502, 'AI 消息来源结构无效');
  return v;
}

export function summaryHash(parts: unknown[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
