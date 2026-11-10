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
async function safeFetch(url: string, transport: typeof fetch, safeCheck: typeof checkUrlSafe, signal: AbortSignal): Promise<{ response: Response; url: string }> {
  {
    let current = url;
    for (let hop = 0; ; hop++) {
      const safe = await safeCheck(current);
      if (!safe.ok) throw new PublicError(`地址未通过安全校验（第 ${hop + 1} 跳）`);
      if (signal.aborted) throw new PublicError('请求超时');
      const response = await transport(safe.url, { signal, redirect: 'manual', headers: {
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
  }
}

/** 整次操作（安全校验、每一跳、读取正文）一个截止时间；正文读完或放弃后才清除计时器。 */
async function withDeadline<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new PublicError('请求超时')); }, ms); });
  try { return await Promise.race([fn(ac.signal), timeout]); }
  finally { clearTimeout(timer); }
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
  safeCheck: typeof checkUrlSafe = checkUrlSafe, timeoutMs = 8000,
): Promise<FactEvidence> {
  const checkedAt = new Date().toISOString();
  const out: FactEvidence = { checkedAt, currentDate: checkedAt.slice(0, 10), origin: null, results: [] };
  try {
    if (originUrl) {
      // 首次安全校验（含 DNS 解析）也在截止时间内
      try {
        out.origin = await withDeadline(timeoutMs, async signal => {
          const safe = await safeCheck(originUrl);
          if (!safe.ok) return null;
          try {
            const { response } = await safeFetch(safe.url, transport, safeCheck, signal);
            try { await response.body?.cancel(); } catch { /* response may already be closed by a test transport */ }
            return { url: safe.url, reachable: response.ok, status: response.status };
          } catch { return { url: safe.url, reachable: false }; }
        });
      } catch { out.origin = { url: originUrl, reachable: false }; }
    }
    const query = originUrl
      ? `"${title.slice(0, 120)}" site:${new URL(originUrl).hostname}`
      : `"${title.slice(0, 120)}"`;
    const searchUrl = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
    const body = await withDeadline(timeoutMs, async signal => {
      const { response } = await safeFetch(searchUrl, transport, safeCheck, signal);
      if (!response.ok) { try { await response.body?.cancel(); } catch { /* 已关闭 */ } throw new PublicError(`搜索 HTTP ${response.status}`); }
      return readCapped(response);
    });
    const parsed = xml.parse(body);
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
