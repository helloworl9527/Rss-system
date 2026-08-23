import { createHash } from 'node:crypto';
import { loadRules, re } from './rules.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------- URL 规范化（PRD 7.2 / rules.url_normalization） ----------
export function canonicalizeUrl(input: string): string | null {
  const R = loadRules().url_normalization;
  let u: URL;
  try { u = new URL(input.trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;

  if (R.lowercase_host) u.hostname = u.hostname.toLowerCase();
  const alias = R.host_aliases?.[u.hostname];
  if (alias) u.hostname = alias;
  if (R.drop_default_port &&
      ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')))
    u.port = '';
  if (R.strip_fragment) u.hash = '';

  // 追踪参数：先算保留白名单，再删
  const keep = new Set<string>(R.preserve_params_by_host?.[u.hostname] ?? []);
  const prefixes: string[] = R.tracking_params?.prefix ?? [];
  const exact = new Set<string>(R.tracking_params?.exact ?? []);
  for (const k of [...u.searchParams.keys()]) {
    if (keep.has(k)) continue;
    if (exact.has(k) || prefixes.some(p => k.startsWith(p))) u.searchParams.delete(k);
  }
  if (R.sort_query_params) {
    const e = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [k, v] of e) u.searchParams.append(k, v);
  }
  if (R.trailing_slash === 'strip' && u.pathname !== '/' && u.pathname.endsWith('/'))
    u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

// ---------- 稳定标识（PRD 7.1 优先级） ----------
export type ItemKey = { key: string; kind: string };

export function extractItemKey(url: string | null, guid: string | null,
                               sourceId: string, title: string, publishedAt: string | null): ItemKey {
  const R = loadRules().url_normalization;
  if (url) {
    let u: URL | null = null;
    try { u = new URL(url); } catch { /* ignore */ }
    if (u) {
      const host = R.host_aliases?.[u.hostname.toLowerCase()] ?? u.hostname.toLowerCase().replace(/^www\./, '');
      for (const p of R.topic_id_patterns ?? []) {
        if (host !== p.host) continue;
        const m = u.pathname.match(new RegExp(p.path_regex));
        if (m) return { key: p.key_template.replace(/\{(\d+)\}/g, (_: string, i: string) => m[+i] ?? ''), kind: p.name };
      }
    }
  }
  // GUID 仅在看起来稳定时采用（PRD 7.1：不是随机生成的）
  if (guid && !/^[0-9a-f]{32,}$/i.test(guid) && guid.length < 200)
    return { key: `guid:${guid}`, kind: 'guid' };
  const cu = url ? canonicalizeUrl(url) : null;
  if (cu) return { key: `url:${cu}`, kind: 'canonical_url' };
  // 兜底：来源 + 规范化标题 + 时间桶（PRD 7.1 第 5 层）
  const bucket = publishedAt ? publishedAt.slice(0, 13) : 'nodate';
  return { key: `tt:${sourceId}:${sha256(title.trim().toLowerCase()).slice(0, 16)}:${bucket}`, kind: 'title_time' };
}

// ---------- 正文清洗与语义指纹（PRD 7.3） ----------
export function stripHtml(html: string): string {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 语义指纹：剔除回复数、浏览量、相对时间等噪声后再哈希（PRD 7.3）。 */
export function contentFingerprint(text: string): string {
  const F = loadRules().content_fingerprint;
  let t = String(text)
    .replace(/[​-‏﻿]/g, '')
    .replace(/\s+/g, ' ');
  for (const p of F.ignore_patterns ?? []) t = t.replace(re(p, 'g'), '');
  t = t.replace(/\s+/g, ' ').trim().toLowerCase();
  return sha256(t);
}

/** 命中哪些实质更新信号（PRD 7.3）。空数组 = 不算实质更新，不得重发。 */
export function substantiveUpdateSignals(text: string): string[] {
  const F = loadRules().content_fingerprint;
  return (F.substantive_update_signals ?? [])
    .filter((s: any) => re(s).test(text)).map((s: any) => s.name);
}

/** 摘要截断检测（规则 forum_fulltext）。 */
export function isExcerpt(text: string, sourceId: string): boolean {
  const cfg = loadRules().source_specific?.forum_fulltext;
  if (!cfg?.applies_to_sources?.includes(sourceId)) return false;
  return (cfg.truncation_markers ?? []).some((m: string) => text.includes(m));
}

// ---------- 时间归一化（PRD 5.4） ----------
export type ParsedTime = {
  utc: string | null; taipei: string | null; raw: string | null; confidence: string;
};

export function normalizeTime(
  raw: string | null | undefined,
  assumedTz = 'Asia/Taipei',
  opts: { historicalArchive?: boolean } = {},
): ParsedTime {
  const r = raw?.trim() || null;
  if (!r) return { utc: null, taipei: null, raw: null, confidence: 'missing' };
  const d = new Date(r);
  if (isNaN(d.getTime())) return { utc: null, taipei: null, raw: r, confidence: 'unparseable' };

  const now = Date.now();
  let confidence = 'exact';
  // 无时区标记 → assumed（PRD 5.4）
  if (!/(Z|[+-]\d{2}:?\d{2}|GMT|UTC|[A-Z]{3,4})\s*$/.test(r)) confidence = 'assumed';
  // 只有日期无时分
  if (/^\d{4}-\d{2}-\d{2}$/.test(r)) confidence = 'date_only';
  // 未来 >6h 或早于 90 天 → 异常（PRD 5.4）
  const dt = d.getTime();
  if (dt - now > 6 * 3600e3) confidence = 'anomalous';
  else if (now - dt > 90 * 86400e3) {
    // 更新日志/归档页天然包含全部历史，老条目是预期内的，不该每天占据
    // 审计区的「来源异常」。标为 stale：同样不自动入选，但与可疑时间戳区分。
    confidence = opts.historicalArchive ? 'stale' : 'anomalous';
  }

  return {
    utc: d.toISOString(),
    taipei: new Intl.DateTimeFormat('sv-SE', {
      timeZone: assumedTz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(d).replace(' ', 'T'),
    raw: r, confidence
  };
}

// ---------- 固定窗口（PRD 5.1） ----------
export type Win = { key: string; label: string; start: Date; end: Date };

/** 台北时区下某时刻所属的固定窗口。边界左闭右开。 */
export function windowOf(at: Date = new Date()): Win {
  const tp = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(at).replace(' ', 'T');
  const datePart = tp.slice(0, 10);
  const hour = +tp.slice(11, 13);

  // 台北 = UTC+8 恒定（无夏令时，PRD 23.1）
  // 日期加减必须在纯 UTC 午夜上做：若用带 +08:00 偏移的时刻，
  // toISOString() 会退回前一个 UTC 日，导致加减整体偏移一天。
  const shiftDay = (ymd: string, days: number) => {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const at_ = (ymd: string, h: number) => new Date(`${ymd}T${String(h).padStart(2, '0')}:00:00+08:00`);

  if (hour < 8)  return { key: `${datePart}:morning`, label: '早报', start: at_(shiftDay(datePart, -1), 22), end: at_(datePart, 8) };
  if (hour < 12) return { key: `${datePart}:noon`,    label: '午报', start: at_(datePart, 8),  end: at_(datePart, 12) };
  if (hour < 22) return { key: `${datePart}:evening`, label: '晚报', start: at_(datePart, 12), end: at_(datePart, 22) };
  // 22:00 之后属于「次日早报」窗口
  const next = shiftDay(datePart, 1);
  return { key: `${next}:morning`, label: '早报', start: at_(datePart, 22), end: at_(next, 8) };
}
