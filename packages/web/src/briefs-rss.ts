/**
 * 日报 RSS：每期已定稿的日报一条。
 *
 * 正文不复用邮件 HTML：邮件为兼容各家客户端用了表格布局、固定宽度和全量内联样式，
 * 在 NetNewsWire 里会渲染成带边框的窄盒子并重复标题。这里从 brief_items 重建一份
 * 语义化 HTML（分区 h2、条目 h3、段落），分区顺序与标题取自 rules.yaml，与邮件一致；
 * 排版完全交给阅读器主题。令牌存于 feed_tokens（name='briefs'）。
 */
import { randomBytes } from 'node:crypto';
import type { DB } from '../../db/src/index.ts';
import { loadRules } from '../../domain/src/rules.ts';
import { htmlEsc as esc, rssDocument, safeHref, type FeedItem } from './feed-xml.ts';

export function briefFeedToken(db: DB): string | null {
  return (db.prepare("SELECT token FROM feed_tokens WHERE name='briefs'").get() as any)?.token ?? null;
}

export function rotateBriefFeedToken(db: DB, revoke = false): string | null {
  const token = revoke ? null : randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO feed_tokens(name,token,rotated_at) VALUES('briefs',?,?)
    ON CONFLICT(name) DO UPDATE SET token=excluded.token, rotated_at=excluded.rotated_at`).run(token, new Date().toISOString());
  return token;
}

type Section = { id: string; title: string };
const TZ = 'Asia/Taipei';
const hhmm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const mdLabel = (iso: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(iso)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${p.month}月${p.day}日`;
};

/** 一期日报的阅读器正文。sections 默认取 rules.yaml，测试可注入。 */
export function briefFeedHtml(db: DB, briefId: number, sections: Section[] = defaultSections()): { html: string; titles: string[]; count: number } {
  const b = db.prepare(`SELECT b.created_at, r.window_start_at, r.window_end_at FROM briefs b JOIN runs r ON r.id=b.run_id WHERE b.id=?`).get(briefId) as any;
  const items = db.prepare(`SELECT i.id, i.story_cluster_id, i.section, i.order_no, i.status, i.title, i.conclusion, i.summary_json,
      i.source_name, i.source_url, coalesce(s.display_name, i.source_name) source_display, s.site_url
    FROM brief_items i LEFT JOIN sources s ON s.id=i.source_name WHERE i.brief_id=? ORDER BY i.order_no`).all(briefId) as any[];
  // 「另见」：同一故事的补充来源，只取这期日报生成时已有的成员
  const others = db.prepare(`SELECT DISTINCT coalesce(s.display_name, f.source_id) name, s.site_url site
    FROM cluster_members m JOIN item_versions v ON v.id=m.item_version_id JOIN feed_items f ON f.id=v.item_id
    LEFT JOIN sources s ON s.id=f.source_id
    WHERE m.cluster_id=? AND m.contribution='补充来源' AND m.created_at<=? AND f.source_id<>?`);
  const link = (href: string | null, text: string) => href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);

  const titles: string[] = [];   // 按正文顺序，供列表预览
  const known = new Set(sections.map(s => s.id));
  const ordered = [...sections, ...[...new Set(items.map(i => String(i.section)))].filter(id => !known.has(id)).map(id => ({ id, title: id }))];
  const body = ordered.map(sec => {
    const xs = items.filter(i => i.section === sec.id);
    if (!xs.length) return '';
    return `<h2>${esc(sec.title)}</h2>` + xs.map(i => {
      const url = safeHref(i.source_url);
      titles.push(String(i.title));
      let summary: string[] = [];
      try { summary = JSON.parse(i.summary_json ?? '[]'); } catch { /* 旧数据 */ }
      const also = i.story_cluster_id ? (others.all(i.story_cluster_id, b.created_at, i.source_name) as any[]) : [];
      const meta = [`来源：${link(safeHref(i.site_url), i.source_display)}`,
        also.length ? `另见：${also.map(o => link(safeHref(o.site), o.name)).join('、')}` : '',
        url ? `<a href="${esc(url)}">阅读原文 ›</a>` : ''].filter(Boolean).join('　');
      return `<h3>${link(url, i.title)}</h3>` +
        `<p><strong>${esc(i.conclusion)}</strong></p>` +
        (summary.length ? `<p>${summary.map(esc).join('')}</p>` : '') +
        `<p><small>${meta}</small></p>`;
    }).join('');
  }).join('');
  const head = `<p>${esc(hhmm(b.window_start_at))}–${esc(hhmm(b.window_end_at))} 的新内容，共 ${items.length} 条。</p>`;
  return { html: head + body, titles, count: items.length };
}

function defaultSections(): Section[] {
  try {
    return ((loadRules() as any).brief?.sections ?? [])
      .filter((s: any) => s.id !== 'core_highlights' && s.id !== 'audit').map((s: any) => ({ id: s.id, title: s.title }));
  } catch { return []; }
}

export function briefsRss(db: DB, token: string, baseUrl: string, limit = 20, sections?: Section[]): string | null {
  const current = briefFeedToken(db);
  if (!current || current !== token) return null;
  const rows = db.prepare(`SELECT b.id, b.created_at, r.id run_id, r.window_key, r.window_label, r.window_end_at,
      (SELECT d.sent_at FROM deliveries d WHERE d.brief_id=b.id AND d.status='sent' ORDER BY d.sent_at LIMIT 1) sent_at
    FROM briefs b JOIN runs r ON r.id=b.run_id
    WHERE b.status='final' AND b.version=(SELECT max(version) FROM briefs x WHERE x.run_id=b.run_id AND x.status='final')
    ORDER BY r.window_start_at DESC LIMIT ?`).all(limit) as any[];
  const items: FeedItem[] = rows.map(r => {
    const f = briefFeedHtml(db, r.id, sections);
    return { title: `${mdLabel(r.window_end_at)} ${r.window_label} · ${f.count} 条`, link: `${baseUrl}/runs/${r.run_id}`,
      guid: `brief:${r.window_key}:${r.id}`, pubDate: r.sent_at ?? r.created_at, html: f.html,
      summary: f.titles.slice(0, 3).join('；') + (f.count > 3 ? ' 等' : ''), author: '十六源日报' };
  });
  return rssDocument({ title: '十六源日报', link: baseUrl, selfUrl: `${baseUrl}/rss/briefs/${token}`,
    description: '每天早、午、晚三期，内容与邮件相同', items, ttlMinutes: 60 });
}
