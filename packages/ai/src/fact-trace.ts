import { errorText, PublicError } from './errors.ts';
import { XMLParser } from 'fast-xml-parser';
import { checkUrlSafe } from '../../connectors/src/ssrf.ts';

export type FactEvidence = {
  checkedAt: string;
  currentDate: string;
  origin: { url: string; reachable: boolean; status?: number } | null;
  results: Array<{ title: string; url: string; snippet: string }>;
  error?: string;
};

const xml = new XMLParser({ ignoreAttributes: false, trimValues: true });
const text = (v: unknown) => typeof v === 'string' ? v : v == null ? '' : String(v);

const MAX_HOPS = 5;
const MAX_BODY = 1024 * 1024;

/**
 * 逐跳校验的抓取：不自动跟随重定向，每一跳都重新做 SSRF 校验（公开网址返回指向内网的重定向会被拒）；
 * 整次操作一个截止时间（不每跳重置），中间响应体立即关闭。
 * 残余风险：DNS 校验与实际连接之间域名解析结果被改（DNS rebinding）不在这里解决（docs/error-hygiene-design.md）。
 */
async function safeFetch(url: string, transport: typeof fetch, safeCheck: typeof checkUrlSafe, timeoutMs: number): Promise<{ response: Response; url: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      const safe = await safeCheck(current);
      if (!safe.ok) throw new PublicError(`地址未通过安全校验（第 ${hop + 1} 跳）`);
      const response = await transport(safe.url, { signal: ac.signal, redirect: 'manual', headers: {
        'user-agent': 'BriefingFactTrace/1.0',
        accept: 'application/rss+xml, application/xml, text/html;q=0.8',
      } });
      const loc = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && loc) {
        try { await response.body?.cancel(); } catch { /* 已关闭 */ }
        if (hop + 1 >= MAX_HOPS) throw new PublicError('重定向次数过多');
        current = new URL(loc, safe.url).href;
        continue;
      }
      return { response, url: safe.url };
    }
  } finally { clearTimeout(timer); }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY) { await reader.cancel().catch(() => {}); throw new PublicError('搜索响应过大'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 实时核验候选原始链接，并从公开搜索结果取回独立来源摘要供复核模型比对。 */
export async function traceFacts(
  title: string, originUrl: string | null, transport: typeof fetch = fetch,
  safeCheck: typeof checkUrlSafe = checkUrlSafe,
): Promise<FactEvidence> {
  const checkedAt = new Date().toISOString();
  const out: FactEvidence = { checkedAt, currentDate: checkedAt.slice(0, 10), origin: null, results: [] };
  try {
    if (originUrl) {
      const safe = await safeCheck(originUrl);
      if (safe.ok) {
        try {
          const { response } = await safeFetch(safe.url, transport, safeCheck, 8000);
          out.origin = { url: safe.url, reachable: response.ok, status: response.status };
          try { await response.body?.cancel(); } catch { /* response may already be closed by a test transport */ }
        } catch { out.origin = { url: safe.url, reachable: false }; }
      }
    }
    const query = originUrl
      ? `"${title.slice(0, 120)}" site:${new URL(originUrl).hostname}`
      : `"${title.slice(0, 120)}"`;
    const searchUrl = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
    const { response } = await safeFetch(searchUrl, transport, safeCheck, 8000);
    if (!response.ok) throw new PublicError(`搜索 HTTP ${response.status}`);
    const parsed = xml.parse(await readCapped(response));
    const raw = parsed?.rss?.channel?.item ?? [];
    const items = Array.isArray(raw) ? raw : [raw];
    out.results = items.slice(0, 5).map((x: any) => ({
      title: text(x?.title).slice(0, 240),
      url: text(x?.link).slice(0, 1000),
      snippet: text(x?.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500),
    })).filter((x: any) => x.title && /^https:\/\//.test(x.url));
  } catch (e: any) {
    out.error = errorText(e);
  }
  return out;
}
