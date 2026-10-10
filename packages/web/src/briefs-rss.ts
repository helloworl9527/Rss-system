/**
 * 日报 RSS：每期已定稿的日报一条，正文就是发出去的邮件 HTML。
 * 同一时段若重新生成过，只取最新版本；令牌存于 feed_tokens（name='briefs'）。
 */
import { randomBytes } from 'node:crypto';
import type { DB } from '../../db/src/index.ts';

const xml = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function briefFeedToken(db: DB): string | null {
  return (db.prepare("SELECT token FROM feed_tokens WHERE name='briefs'").get() as any)?.token ?? null;
}

export function rotateBriefFeedToken(db: DB, revoke = false): string | null {
  const token = revoke ? null : randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO feed_tokens(name,token,rotated_at) VALUES('briefs',?,?)
    ON CONFLICT(name) DO UPDATE SET token=excluded.token, rotated_at=excluded.rotated_at`).run(token, new Date().toISOString());
  return token;
}

export function briefsRss(db: DB, token: string, baseUrl: string, limit = 20): string | null {
  const current = briefFeedToken(db);
  if (!current || current !== token) return null;
  const rows = db.prepare(`SELECT b.id, b.subject, b.html_body, b.created_at, r.window_key, r.window_label,
      (SELECT d.sent_at FROM deliveries d WHERE d.brief_id=b.id AND d.status='sent' ORDER BY d.sent_at LIMIT 1) sent_at
    FROM briefs b JOIN runs r ON r.id=b.run_id
    WHERE b.status='final' AND b.version=(SELECT max(version) FROM briefs x WHERE x.run_id=b.run_id AND x.status='final')
    ORDER BY r.window_start_at DESC LIMIT ?`).all(limit) as any[];
  const items = rows.map(r => `<item><title>${xml(r.subject)}</title><link>${xml(baseUrl)}</link>` +
    `<guid isPermaLink="false">brief:${xml(r.window_key)}:${r.id}</guid>` +
    `<pubDate>${new Date(r.sent_at ?? r.created_at).toUTCString()}</pubDate>` +
    `<description>${xml(r.html_body)}</description></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>十六源日报</title>` +
    `<link>${xml(baseUrl)}</link><description>每天早、午、晚三期，与邮件内容相同</description>${items}</channel></rss>`;
}
