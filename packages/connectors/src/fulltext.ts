import { fetchSmart } from './fetch.ts';
import { stripHtml } from '../../domain/src/normalize.ts';

export type FullText = {
  ok: boolean;
  rateLimited?: boolean;
  text?: string;
  html?: string;
  title?: string;
  publishedRaw?: string | null;
  error?: string;
  fetchedUrl?: string;
};

type Opts = { userAgent: string; timeoutMs: number; maxBytes: number; transport?: 'auto' | 'curl' | 'undici' };

/**
 * LINUX DO（Discourse）：用 /t/topic/{id}.json 而非 HTML 页。
 * 实测 JSON 59 KB vs HTML 422 KB —— 对来源更礼貌，解析也更稳。
 * 取首帖 cooked 作为正文（回复区多为闲聊，不作为 A–D 证据）。
 */
export async function fetchLinuxdo(topicId: string, o: Opts): Promise<FullText> {
  const url = `https://linux.do/t/topic/${topicId}.json`;
  const r = await fetchSmart(url, o);
  if (r.outcome !== 'ok' || !r.body)
    return { ok: false, rateLimited: r.outcome === 'rate_limited',
             error: `${r.outcome}:${r.errorClass ?? r.httpCode ?? ''}`, fetchedUrl: url };
  try {
    const d = JSON.parse(r.body);
    const first = d?.post_stream?.posts?.[0];
    if (!first?.cooked) return { ok: false, error: 'JSON 无 post_stream.posts[0].cooked', fetchedUrl: url };
    return { ok: true, html: first.cooked, text: stripHtml(first.cooked),
             title: d.title ?? '', publishedRaw: first.created_at ?? d.created_at ?? null, fetchedUrl: url };
  } catch (e: any) {
    return { ok: false, error: `JSON 解析失败: ${e.message}`, fetchedUrl: url };
  }
}

/** V2EX：/api/topics/show.json?id={id}，实测 3.4 KB vs HTML 120 KB。 */
export async function fetchV2ex(topicId: string, o: Opts): Promise<FullText> {
  const url = `https://www.v2ex.com/api/topics/show.json?id=${topicId}`;
  const r = await fetchSmart(url, o);
  if (r.outcome !== 'ok' || !r.body)
    return { ok: false, rateLimited: r.outcome === 'rate_limited',
             error: `${r.outcome}:${r.errorClass ?? r.httpCode ?? ''}`, fetchedUrl: url };
  try {
    const arr = JSON.parse(r.body);
    const t = Array.isArray(arr) ? arr[0] : arr;
    if (!t) return { ok: false, error: 'API 返回空数组', fetchedUrl: url };
    const html = t.content_rendered ?? '';
    return { ok: true, html, text: t.content ? String(t.content) : stripHtml(html),
             title: t.title ?? '',
             publishedRaw: t.created ? new Date(t.created * 1000).toISOString() : null, fetchedUrl: url };
  } catch (e: any) {
    return { ok: false, error: `JSON 解析失败: ${e.message}`, fetchedUrl: url };
  }
}

/**
 * 通用文章页正文抽取（Elsewhere 等）。
 * 轻量 readability：优先 <article>，否则取正文密度最高的 <div>/<section>。
 * 不引入额外依赖 —— 896 MB 机器上能省则省。
 */
export async function fetchArticle(url: string, o: Opts): Promise<FullText> {
  const r = await fetchSmart(url, o);
  if (r.outcome !== 'ok' || !r.body)
    return { ok: false, rateLimited: r.outcome === 'rate_limited',
             error: `${r.outcome}:${r.errorClass ?? r.httpCode ?? ''}`, fetchedUrl: url };

  const body = r.body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');

  const title = body.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]
             ?? body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
             ?? '';
  const published = body.match(/<meta[^>]+property="article:published_time"[^>]+content="([^"]+)"/i)?.[1]
                 ?? body.match(/<time[^>]+datetime="([^"]+)"/i)?.[1] ?? null;

  // 候选容器：<article> 优先，否则所有 div/section 里文本最多的
  let best = body.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? '';
  if (stripHtml(best).length < 400) {
    for (const m of body.matchAll(/<(div|section)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const cand = m[0]!;
      if (stripHtml(cand).length > stripHtml(best).length) best = cand;
    }
  }
  const text = stripHtml(best || body);
  return { ok: true, html: best || body, text, title: stripHtml(title), publishedRaw: published, fetchedUrl: url };
}

/** 按来源分派。返回 null 表示该来源不需要全文抓取。 */
export function fulltextFetcher(sourceId: string, itemKey: string, canonicalUrl: string | null) {
  const idFrom = (prefix: string) => itemKey.startsWith(prefix) ? itemKey.slice(prefix.length) : null;
  switch (sourceId) {
    case 'linuxdo': { const id = idFrom('linuxdo:t:'); return id ? (o: Opts) => fetchLinuxdo(id, o) : null; }
    case 'v2ex':    { const id = idFrom('v2ex:t:');    return id ? (o: Opts) => fetchV2ex(id, o)    : null; }
    case 'elsewhere': return canonicalUrl ? (o: Opts) => fetchArticle(canonicalUrl, o) : null;
    default: return null;
  }
}
