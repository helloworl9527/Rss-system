import type { TelegramDB } from './db.ts';
import { consolidateViewpoints, stripMessageReferences } from './core.ts';
import { channelName } from './digest.ts';

const xml = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// 兼容已经落库的历史总结：引用仍保留在 summary_json 供审计，RSS 不展示消息 ID/时间结构。
const withoutMessageSources = (html: unknown) => String(html ?? '')
  .replace(/<h2>消息来源<\/h2>(?:<ul>.*?<\/ul>|<p>无<\/p>)/s, '');
const consolidatedRenderedViewpoints = (html: string) => html
  .replace(/(<h2>主要观点<\/h2>)<ul>(.*?)<\/ul>/s, (_all, heading, items) => {
    const points = [...String(items).matchAll(/<li>(.*?)<\/li>/gs)].map(x => x[1]);
    const paragraph = consolidateViewpoints(points);
    return `${heading}${paragraph ? `<p>${paragraph}</p>` : '<p>无</p>'}`;
  })
  .replace(/(<h2>主要观点<\/h2><p>)(.*?)(<\/p>)/s, (_all, open, value, close) => `${open}${consolidateViewpoints([value]) || '无'}${close}`);
const withoutVagueLeadIns = (html: string) => html.replace(
  /(?:(?:有人|群友)(?:提出|认为|表示|提到|指出|建议|质疑)|消息中提到)[：:，,]?\s*/gu,
  '',
);
const publicSummary = (html: unknown) => withoutVagueLeadIns(consolidatedRenderedViewpoints(stripMessageReferences(withoutMessageSources(html))));

const displayName = channelName;
const monthDay = (value: string, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(value));
  const values = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${values.month}-${values.day}`;
};

function feed(title: string, link: string, rows: any[], timezone: string): string {
  const items = rows.map(r => `<item><title>${xml(`${displayName(r.source_name)} ${monthDay(r.window_end, timezone)}`)}</title><link>${xml(link)}</link>` +
    `<guid isPermaLink="false">telegram:${r.source_id}:${xml(r.window_start)}:${xml(r.window_end)}</guid>` +
    `<pubDate>${new Date(r.window_end).toUTCString()}</pubDate><description>${xml(publicSummary(r.rendered_html))}</description></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xml(title)}</title>` +
    `<link>${xml(link)}</link><description>Telegram 已关闭窗口总结</description>${items}</channel></rss>`;
}

export function sourceRss(db: TelegramDB, token: string, baseUrl: string): string | null {
  const source = db.prepare(`SELECT id,coalesce(display_name,title,reference) name FROM telegram_sources
    WHERE rss_token=? AND source_type='normal'`).get(token) as any;
  if (!source) return null;
  const rows = db.prepare(`SELECT s.*,j.window_start,j.window_end FROM telegram_summaries s
    JOIN telegram_summary_jobs j ON j.id=s.job_id WHERE s.source_id=? AND s.expires_at>?
    ORDER BY j.window_end DESC LIMIT 100`).all(source.id, new Date().toISOString()) as any[];
  const timezone = (db.prepare('SELECT timezone FROM telegram_settings WHERE singleton=1').get() as any).timezone;
  return feed(`Telegram · ${source.name}`, baseUrl, rows.map(r => ({ ...r, source_name: source.name })), timezone);
}

export function allRss(db: TelegramDB, token: string, baseUrl: string): string | null {
  const setting = db.prepare('SELECT all_rss_token FROM telegram_settings WHERE singleton=1').get() as any;
  if (!setting?.all_rss_token || setting.all_rss_token !== token) return null;
  const rows = db.prepare(`SELECT sm.*,j.window_start,j.window_end,coalesce(s.display_name,s.title,s.reference) source_name FROM telegram_summaries sm
    JOIN telegram_summary_jobs j ON j.id=sm.job_id JOIN telegram_sources s ON s.id=sm.source_id
    WHERE s.source_type='normal' AND s.enabled=1 AND sm.expires_at>? ORDER BY j.window_end DESC LIMIT 200`)
    .all(new Date().toISOString()) as any[];
  const timezone = (db.prepare('SELECT timezone FROM telegram_settings WHERE singleton=1').get() as any).timezone;
  return feed('Telegram 群组总结', baseUrl, rows, timezone);
}

/** 跨频道汇总：每个关闭时刻一条，复用全部频道 RSS 的令牌。 */
export function digestRss(db: TelegramDB, token: string, baseUrl: string): string | null {
  const setting = db.prepare('SELECT all_rss_token,timezone FROM telegram_settings WHERE singleton=1').get() as any;
  if (!setting?.all_rss_token || setting.all_rss_token !== token) return null;
  const rows = db.prepare(`SELECT * FROM telegram_digests WHERE status='completed' AND (expires_at IS NULL OR expires_at>?)
    ORDER BY window_end DESC LIMIT 100`).all(new Date().toISOString()) as any[];
  // 早 / 午 / 晚 按关闭时刻的本地小时划分，与 08:00 / 12:00 / 22:00 三档对应
  const slot = (value: string) => {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: setting.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(value)));
    return h < 11 ? '早' : h < 17 ? '午' : '晚';
  };
  const items = rows.map(r => `<item><title>${xml(`📌 Telegram 要点 · ${monthDay(r.window_end, setting.timezone)} ${slot(r.window_end)}`)}</title>` +
    `<link>${xml(baseUrl)}</link><guid isPermaLink="false">telegram-digest:${xml(r.window_end)}</guid>` +
    `<pubDate>${new Date(r.window_end).toUTCString()}</pubDate><description>${xml(withoutVagueLeadIns(String(r.rendered_html ?? '')))}</description></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Telegram 跨频道汇总</title>` +
    `<link>${xml(baseUrl)}</link><description>每个时段一条，汇总所有频道并标注来源</description>${items}</channel></rss>`;
}
