import { XMLParser } from 'fast-xml-parser';

export type RawItem = {
  title: string;
  html: string;            // 原始正文 HTML
  link: string | null;
  guid: string | null;
  publishedRaw: string | null;
  author: string | null;
};

const xml = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', cdataPropName: '__cdata',
  trimValues: true, parseTagValue: false,
});

const txt = (v: any): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'object') return txt(v.__cdata ?? v['#text'] ?? '');
  return '';
};

/** RSS 2.0 + Atom，容忍 CDATA、HTML 描述与不规范日期（PRD 4.4）。 */
export function parseFeed(body: string): RawItem[] {
  const doc = xml.parse(body);
  const out: RawItem[] = [];

  for (const it of [].concat(doc?.rss?.channel?.item ?? doc?.['rdf:RDF']?.item ?? [])) {
    const i: any = it;
    out.push({
      title: txt(i.title),
      html: txt(i['content:encoded']) || txt(i.description) || '',
      link: txt(i.link) || null,
      guid: txt(i.guid) || null,
      publishedRaw: txt(i.pubDate) || txt(i['dc:date']) || null,
      author: txt(i.author) || txt(i['dc:creator']) || null,
    });
  }
  for (const en of [].concat(doc?.feed?.entry ?? [])) {
    const e: any = en;
    const links = [].concat(e.link ?? []);
    const alt = links.find((l: any) => !l?.['@rel'] || l['@rel'] === 'alternate');
    out.push({
      title: txt(e.title),
      html: txt(e.content) || txt(e.summary) || '',
      link: (alt as any)?.['@href'] ?? txt(e.link) ?? null,
      guid: txt(e.id) || null,
      publishedRaw: txt(e.published) || txt(e.updated) || null,
      author: txt(e.author?.name) || null,
    });
  }
  return out.filter(i => i.title || i.html);
}

/**
 * t.me/s/<channel> 网页版解析（实施方案 2.2 的 Telegram 二级兜底）。
 * 不依赖任何第三方 RSSHub 实例。data-post 形如 "durov/123"，
 * 正好满足 PRD 7.1「Telegram channel + message ID」的身份键要求。
 */
export function parseTelegramWeb(body: string, channel: string): RawItem[] {
  const out: RawItem[] = [];
  // 注意：不能按 class 前缀切块 —— `tgme_widget_message` 同时是 _text/_meta
  // 等子元素的前缀，会把正文容器切到相邻块里。改为按 data-post 出现位置切片。
  const marks = [...body.matchAll(/data-post="([^"]+)"/g)];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    const post = m[1]!;
    const start = m.index!;
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : body.length;
    const block = body.slice(start, end);

    const textHtml = block.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
    const time = block.match(/<time[^>]+datetime="([^"]+)"/)?.[1] ?? null;
    if (!textHtml.trim()) continue;

    const plain = textHtml.replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();

    out.push({
      title: plain.slice(0, 120),
      html: textHtml,
      link: `https://t.me/${post}`,
      guid: `tg:${post.replace('/', ':')}`,
      publishedRaw: time,
      author: `@${channel}`,
    });
  }
  return out;
}

/**
 * DeepSeek 更新日志网页（PRD FR-013：按日期、标题、链接和正文片段构建版本指纹）。
 *
 * 页面结构（Docusaurus）：
 *   <h2 id="时间-2026-08-21">时间: 2026-08-21</h2>     ← 日期节
 *   <h3 id="deepseek-v4-flash-vision-exp-发布">…</h3>  ← 该日期下的发布条目
 * h3 的 id 是稳定锚点，用作身份键并拼出深链。
 *
 * 注意：早期实现按 h2/h3 标题文本做键，而「deepseek-chat」这类标题会在
 * 多个日期节里重复出现，导致 5 个不同发布被折叠成同一条目的 5 个版本。
 * 键必须包含日期。
 */
export function parseDeepseekPage(body: string): RawItem[] {
  const BASE = 'https://api-docs.deepseek.com/zh-cn/updates/';
  const out: RawItem[] = [];
  const zw = (t: string) => t.replace(/[\u200b-\u200f\ufeff]/g, '');

  const heads = [...body.matchAll(/<(h[23])\b([^>]*)>([\s\S]*?)<\/\1>/g)];
  let curDate: string | null = null;

  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    const tag = h[1]!;
    const attrs = h[2]!;
    const id = attrs.match(/id="([^"]+)"/)?.[1] ?? '';
    const text = zw(h[3]!.replace(/<[^>]+>/g, '')).trim();

    if (tag === 'h2') {
      // 日期节：从 id 或文本里取 YYYY-MM-DD
      curDate = (id.match(/(\d{4}-\d{2}-\d{2})/) ?? text.match(/(\d{4}-\d{2}-\d{2})/))?.[1] ?? null;
      continue;
    }

    // h3 = 一条发布。正文取到下一个 h2/h3 之前
    const bodyStart = h.index! + h[0]!.length;
    const bodyEnd = heads[i + 1]?.index ?? body.length;
    const section = body.slice(bodyStart, bodyEnd);

    out.push({
      title: curDate ? `${text}（${curDate}）` : text,
      html: section,
      link: id ? `${BASE}#${encodeURIComponent(id)}` : BASE,
      // 键含日期 → 同名标题在不同日期下互不碰撞
      guid: `deepseek:${curDate ?? 'undated'}:${zw(id) || text.slice(0, 60)}`,
      publishedRaw: curDate,
      author: 'DeepSeek',
    });
  }
  return out;
}

export function parseBy(parser: string, body: string, ctx: { channel?: string }): RawItem[] {
  switch (parser) {
    case 'rss': case 'atom':   return parseFeed(body);
    case 'telegram_web':       return parseTelegramWeb(body, ctx.channel ?? '');
    case 'deepseek_page':      return parseDeepseekPage(body);
    default: throw new Error(`未知解析器: ${parser}`);
  }
}
