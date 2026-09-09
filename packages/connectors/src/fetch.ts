import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Throttler } from './throttle.ts';

const execFileAsync = promisify(execFile);

export type FetchOutcome =
  | 'ok' | 'not_modified' | 'fetch_failed' | 'source_anomaly' | 'parse_failed'
  // 限流与内容失败必须分开：限流不是「这条内容抓不到」，
  // 不该消耗重试次数，否则条目会被永久放弃。
  | 'rate_limited';

export type FetchResult = {
  outcome: FetchOutcome;
  httpCode?: number;
  contentType?: string | null;
  retryAfterMs?: number;
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
      return { outcome: 'not_modified', httpCode: 304, contentType: r.headers.get('content-type'), latencyMs };

    if (!r.ok) {
      return { outcome: r.status === 429 ? 'rate_limited' : 'fetch_failed', httpCode: r.status, contentType: r.headers.get('content-type'),
               retryAfterMs: r.headers.get('retry-after') ? Number(r.headers.get('retry-after')) * 1000 : undefined, latencyMs,
               errorClass: r.status >= 500 ? 'http_5xx' : 'http_4xx',
               errorMessage: `HTTP ${r.status}` };
    }

    // 体积上限：边读边计数，超限即断（PRD 4.4 防资源耗尽）
    const reader = r.body?.getReader();
    if (!reader) return { outcome: 'source_anomaly', httpCode: r.status, contentType: r.headers.get('content-type'), latencyMs,
                          errorClass: 'empty', errorMessage: '响应无 body' };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel();
        return { outcome: 'fetch_failed', httpCode: r.status, contentType: r.headers.get('content-type'), latencyMs: Date.now() - t0,
                 errorClass: 'too_large', errorMessage: `响应超过 ${opts.maxBytes} 字节上限` };
      }
      chunks.push(value);
    }
    const body = new TextDecoder('utf-8').decode(Buffer.concat(chunks));

    // 200 但空 feed → source_anomaly，不得写成「无更新」（PRD 18 章）
    if (body.trim().length === 0)
      return { outcome: 'source_anomaly', httpCode: r.status, contentType: r.headers.get('content-type'), bytes: 0, latencyMs: Date.now() - t0,
               errorClass: 'empty', errorMessage: '200 但响应体为空' };

    return { outcome: 'ok', httpCode: r.status, contentType: r.headers.get('content-type'), body, bytes: total,
             etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified'),
             latencyMs: Date.now() - t0 };
  } catch (e: any) {
    return { outcome: 'fetch_failed', latencyMs: Date.now() - t0,
             errorClass: ERR_CLASS(e), errorMessage: String(e?.message ?? e) };
  } finally { clearTimeout(timer); }
}

/**
 * curl 传输通道。
 *
 * 【为什么需要】linux.do 在 Cloudflare bot management 之后，对 Node 内置
 * fetch(undici) 一律返回 403 `cf-mitigated: challenge`，而 curl 即便带
 * 机器人 UA 也稳定 200。实测：undici + 完整浏览器请求头（sec-ch-ua、
 * sec-fetch-* 全给）仍是 403 —— 判定依据是 TLS/HTTP2 指纹，不是请求头，
 * 所以补 header 无解。curl 已随系统安装，零新依赖，且全文抓取量很小
 * （linux.do 约 39 次/天），进程开销可忽略。
 *
 * 注意：本通道不做条件 GET（全文按 item_version 只抓一次，用不到 ETag）。
 */
export async function fetchViaCurl(
  url: string,
  opts: { timeoutMs: number; userAgent: string; maxBytes: number;
          etag?: string | null; lastModified?: string | null },
): Promise<FetchResult> {
  const t0 = Date.now();
  const SEP = '\n__CURL_META__';
  const tempDir = mkdtempSync(join(tmpdir(), 'brief-curl-'));
  const headerPath = join(tempDir, 'headers');
  try {
    const args = [
      '-sS', '-L', '--compressed',
      '--max-time', String(Math.ceil(opts.timeoutMs / 1000)),
      '--max-redirs', '3',
      '-A', opts.userAgent,
      '--dump-header', headerPath,
    ];
    if (opts.etag) args.push('-H', `If-None-Match: ${opts.etag}`);
    if (opts.lastModified) args.push('-H', `If-Modified-Since: ${opts.lastModified}`);
    // Ubuntu 22.04 自带 curl 7.81，不支持较新的 %header{name} write-out。
    // 响应头单独落到受控临时目录，兼容旧版 curl 并避免污染正文。
    args.push('-w', `${SEP}%{http_code}\n%{content_type}`, url);
    const { stdout } = await execFileAsync('curl', args,
      { maxBuffer: opts.maxBytes + 4096, timeout: opts.timeoutMs + 2000, encoding: 'utf8' });

    const i = stdout.lastIndexOf(SEP);
    if (i < 0) return { outcome: 'fetch_failed', latencyMs: Date.now() - t0,
                        errorClass: 'network', errorMessage: 'curl 未返回状态码' };
    const body = stdout.slice(0, i);
    const meta = stdout.slice(i + SEP.length).split(/\r?\n/);
    const code = Number(meta[0]?.trim());
    const contentType = meta[1]?.trim() || null;
    const rawHeaders = readFileSync(headerPath, 'utf8');
    // -L 时 dump-header 含多个响应块；只取最终响应的头。
    const blocks = rawHeaders.split(/\r?\n\r?\n/).filter(b => /^HTTP\//i.test(b.trim()));
    const finalHeaders = blocks.at(-1) ?? rawHeaders;
    const header = (name: string) =>
      finalHeaders.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1]?.trim() || null;
    const etag = header('etag');
    const lastModified = header('last-modified');
    const retryRaw = header('retry-after');
    const retrySeconds = retryRaw && /^\d+$/.test(retryRaw)
      ? Number(retryRaw)
      : retryRaw ? Math.max(0, Math.ceil((Date.parse(retryRaw) - Date.now()) / 1000)) : 0;
    const latencyMs = Date.now() - t0;

    if (code === 304) return { outcome: 'not_modified', httpCode: 304, contentType, latencyMs };
    // Cloudflare 限流返回 429 且无 Retry-After，响应体是「Just a moment」质询页；
    // 403 + 同样的质询页也属同一类。都归为 rate_limited。
    const isChallenge = /Just a moment|cf-mitigated|__cf_chl/i.test(body.slice(0, 600));
    const protectedHost = (() => { try { return new URL(url).hostname === 'linux.do'; } catch { return false; } })();
    if (code === 429 || (code === 403 && (isChallenge || protectedHost)))
      return { outcome: 'rate_limited', httpCode: code, contentType, latencyMs,
               retryAfterMs: retrySeconds > 0 ? retrySeconds * 1000 : undefined,
               errorClass: 'rate_limited', errorMessage: `HTTP ${code} 限流/质询` };
    if (code < 200 || code >= 300)
      return { outcome: 'fetch_failed', httpCode: code, latencyMs,
               errorClass: code >= 500 ? 'http_5xx' : 'http_4xx', errorMessage: `HTTP ${code}` };
    if (!body.trim())
      return { outcome: 'source_anomaly', httpCode: code, bytes: 0, latencyMs,
               errorClass: 'empty', errorMessage: '200 但响应体为空' };
    if (Buffer.byteLength(body) > opts.maxBytes)
      return { outcome: 'fetch_failed', httpCode: code, latencyMs,
               errorClass: 'too_large', errorMessage: `响应超过 ${opts.maxBytes} 字节上限` };

    return { outcome: 'ok', httpCode: code, contentType, body, bytes: Buffer.byteLength(body),
             etag, lastModified, latencyMs };
  } catch (e: any) {
    const timedOut = e?.killed || /ETIMEDOUT|timeout/i.test(String(e?.message));
    return { outcome: 'fetch_failed', latencyMs: Date.now() - t0,
             errorClass: timedOut ? 'timeout' : 'network',
             errorMessage: String(e?.stderr || e?.message || e).slice(0, 300) };
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
}

/**
 * 自动通道选择：先走 undici；若被 Cloudflare 质询（403 + cf-mitigated），
 * 自动改走 curl 重试一次。这样无需事先枚举哪些主机需要 curl。
 */
export async function fetchSmart(
  url: string,
  opts: { timeoutMs: number; userAgent: string; maxBytes: number; transport?: 'auto' | 'curl' | 'undici' },
): Promise<FetchResult & { transport: string }> {
  if (opts.transport === 'curl')
    return { ...await fetchViaCurl(url, opts), transport: 'curl' };

  const r = await fetchOnce(url, { ...opts, etag: null, lastModified: null });
  const challenged = r.httpCode === 403 && (r.outcome === 'fetch_failed' || r.outcome === 'rate_limited');
  if (opts.transport === 'undici' || !challenged) return { ...r, transport: 'undici' };

  const c = await fetchViaCurl(url, opts);
  return { ...c, transport: 'curl-after-403' };
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
  unavailableHosts: ReadonlySet<string> = new Set(),
): Promise<{ attempts: Attempt[]; success: Attempt | null }> {
  const attempts: Attempt[] = [];
  const rateLimitedHosts = new Set<string>();
  for (const ep of [...endpoints].sort((a, b) => a.priority - b.priority)) {
    let host = '';
    try { host = new URL(ep.url).hostname; } catch { /* fetch will report invalid URL */ }
    if (unavailableHosts.has(host) || rateLimitedHosts.has(host)) continue;
    const group = throttler.groupFor(ep.url, ep.host_group);
    const maxAttempts = Math.max(1, group.cfg.max_retries + 1);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // linux.do 会按 TLS 指纹质询 Node/undici；直接使用 curl，避免一次注定失败的请求。
      const request = host === 'linux.do' ? fetchViaCurl : fetchOnce;
      const res = await group.run(() => request(ep.url, {
        timeoutMs: group.cfg.timeout_ms,
        userAgent: defaults.userAgent,
        maxBytes: defaults.maxBytes,
        etag: ep.etag, lastModified: ep.last_modified,
      }));
      const a: Attempt = { ...res, endpoint: ep, isFallback: ep.priority > 1 };
      attempts.push(a);
      if (res.outcome === 'ok' || res.outcome === 'not_modified') return { attempts, success: a };
      // 限流后不在同一主机继续尝试其它 URL，也不做秒级重试；由持久化熔断器冷却。
      if (res.outcome === 'rate_limited') { rateLimitedHosts.add(host); break; }
      const retryable = res.errorClass === 'http_5xx' || res.errorClass === 'network' || res.errorClass === 'timeout';
      if (!retryable || attempt === maxAttempts - 1) break;
      const delay = res.retryAfterMs && res.retryAfterMs > 0 ? Math.min(res.retryAfterMs, 60000) : [2000, 8000, 30000][attempt]!;
      await new Promise(resolve => setTimeout(resolve, delay + Math.floor(Math.random() * 250)));
    }
  }
  return { attempts, success: null };
}
