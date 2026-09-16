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

async function timedFetch(url: string, transport: typeof fetch, timeoutMs: number) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await transport(url, { signal: ac.signal, redirect: 'follow', headers: {
      'user-agent': 'BriefingFactTrace/1.0',
      accept: 'application/rss+xml, application/xml, text/html;q=0.8',
    } });
  } finally { clearTimeout(timer); }
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
        const response = await timedFetch(safe.url, transport, 8000);
        out.origin = { url: safe.url, reachable: response.ok, status: response.status };
        try { await response.body?.cancel(); } catch { /* response may already be closed by a test transport */ }
      }
    }
    const query = originUrl
      ? `"${title.slice(0, 120)}" site:${new URL(originUrl).hostname}`
      : `"${title.slice(0, 120)}"`;
    const searchUrl = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
    const response = await timedFetch(searchUrl, transport, 8000);
    if (!response.ok) throw new Error(`搜索 HTTP ${response.status}`);
    const parsed = xml.parse(await response.text());
    const raw = parsed?.rss?.channel?.item ?? [];
    const items = Array.isArray(raw) ? raw : [raw];
    out.results = items.slice(0, 5).map((x: any) => ({
      title: text(x?.title).slice(0, 240),
      url: text(x?.link).slice(0, 1000),
      snippet: text(x?.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500),
    })).filter((x: any) => x.title && /^https:\/\//.test(x.url));
  } catch (e: any) {
    out.error = String(e?.message ?? e).slice(0, 300);
  }
  return out;
}
