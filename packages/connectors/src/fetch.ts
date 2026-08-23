import { Throttler } from './throttle.ts';

export type FetchOutcome =
  | 'ok' | 'not_modified' | 'fetch_failed' | 'source_anomaly' | 'parse_failed';

export type FetchResult = {
  outcome: FetchOutcome;
  httpCode?: number;
  body?: string;
  bytes?: number;
  etag?: string | null;
  lastModified?: string | null;
  latencyMs: number;
  errorClass?: string;
  errorMessage?: string;
};

const ERR_CLASS = (e: any): string => {
  const m = String(e?.message ?? e);
  if (e?.name === 'AbortError' || /timeout/i.test(m)) return 'timeout';
  if (/certificate|TLS|SSL/i.test(m)) return 'tls';
  if (/ENOTFOUND|EAI_AGAIN|dns/i.test(m)) return 'dns';
  return 'network';
};

/** 单次 HTTP 抓取，带条件 GET 与体积上限（PRD 4.4）。 */
export async function fetchOnce(
  url: string,
  opts: { timeoutMs: number; userAgent: string; maxBytes: number;
          etag?: string | null; lastModified?: string | null }
): Promise<FetchResult> {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const headers: Record<string, string> = {
      'user-agent': opts.userAgent,
      'accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.5',
      'accept-encoding': 'gzip, deflate, br',
    };
    if (opts.etag) headers['if-none-match'] = opts.etag;
    if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;

    const r = await fetch(url, { signal: ac.signal, redirect: 'follow', headers });
    const latencyMs = Date.now() - t0;

    if (r.status === 304)
      return { outcome: 'not_modified', httpCode: 304, latencyMs };

    if (!r.ok) {
      return { outcome: 'fetch_failed', httpCode: r.status, latencyMs,
               errorClass: r.status >= 500 ? 'http_5xx' : 'http_4xx',
               errorMessage: `HTTP ${r.status}` };
    }

    // 体积上限：边读边计数，超限即断（PRD 4.4 防资源耗尽）
    const reader = r.body?.getReader();
    if (!reader) return { outcome: 'source_anomaly', httpCode: r.status, latencyMs,
                          errorClass: 'empty', errorMessage: '响应无 body' };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel();
        return { outcome: 'fetch_failed', httpCode: r.status, latencyMs: Date.now() - t0,
                 errorClass: 'too_large', errorMessage: `响应超过 ${opts.maxBytes} 字节上限` };
      }
      chunks.push(value);
    }
    const body = new TextDecoder('utf-8').decode(Buffer.concat(chunks));

    // 200 但空 feed → source_anomaly，不得写成「无更新」（PRD 18 章）
    if (body.trim().length === 0)
      return { outcome: 'source_anomaly', httpCode: r.status, bytes: 0, latencyMs: Date.now() - t0,
               errorClass: 'empty', errorMessage: '200 但响应体为空' };

    return { outcome: 'ok', httpCode: r.status, body, bytes: total,
             etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified'),
             latencyMs: Date.now() - t0 };
  } catch (e: any) {
    return { outcome: 'fetch_failed', latencyMs: Date.now() - t0,
             errorClass: ERR_CLASS(e), errorMessage: String(e?.message ?? e) };
  } finally { clearTimeout(timer); }
}

export type Endpoint = {
  id?: number; priority: number; url: string; parser: string; host_group?: string | null;
  etag?: string | null; last_modified?: string | null;
};
export type Attempt = FetchResult & { endpoint: Endpoint; isFallback: boolean };

/**
 * 按 priority 升序尝试端点，成功即停。
 * 每轮都从 priority 1 开始，不做粘性缓存 —— PRD 18 章要求
 * 「不得因为过去曾 404 而跳过抓取」。所有尝试都返回，供审计落库。
 */
export async function fetchWithFallback(
  endpoints: Endpoint[],
  throttler: Throttler,
  defaults: { userAgent: string; maxBytes: number },
): Promise<{ attempts: Attempt[]; success: Attempt | null }> {
  const attempts: Attempt[] = [];
  for (const ep of [...endpoints].sort((a, b) => a.priority - b.priority)) {
    const group = throttler.groupFor(ep.url, ep.host_group);
    const res = await group.run(() => fetchOnce(ep.url, {
      timeoutMs: group.cfg.timeout_ms,
      userAgent: defaults.userAgent,
      maxBytes: defaults.maxBytes,
      etag: ep.etag, lastModified: ep.last_modified,
    }));
    const a: Attempt = { ...res, endpoint: ep, isFallback: ep.priority > 1 };
    attempts.push(a);
    if (res.outcome === 'ok' || res.outcome === 'not_modified') return { attempts, success: a };
  }
  return { attempts, success: null };
}
