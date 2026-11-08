/**
 * 新版日报（rules.yaml brief.format = digest_v2）的组装、持久化与投递。
 * 由 brief.ts 调用；旧版分区渲染逻辑保留在 brief.ts 中，format 改回后即恢复。
 *
 * 不变量：
 *   - 已投递成功的简报不会重复生成或重发（除非 --regenerate）。
 *   - 先持久化再投递；投递成功后才登记 pushed_events / pushed_projects（72 小时跨期去重）。
 */
import { nowIso, type DB } from '../../../packages/db/src/index.ts';
import { createProvider, providerFromEnv } from '../../../packages/ai/src/registry.ts';
import { buildDigest, recordPushed } from '../../../packages/digest/src/build.ts';
import { loadTelegramDaily } from '../../../packages/digest/src/telegram.ts';
import { stripDealsFromTelegram } from '../../../packages/digest/src/deals.ts';
import { renderDigestHtml, renderDigestText, digestSubject, digestCount } from '../../../packages/digest/src/render.ts';
import type { DigestData } from '../../../packages/digest/src/core.ts';
import { checkEmail } from '../../../packages/templates/src/email.ts';
import { deliver } from '../../../packages/templates/src/delivery.ts';
import { mailerFromEnv } from '../../../packages/templates/src/mailer.ts';

export async function runDigestBrief(o: {
  db: DB; run: any; win: { key: string; label: string; start: Date; end: Date }; rules: any;
  noSend: boolean; shadow: boolean; regenerate: boolean; outDir: string;
}): Promise<number> {
  const { db, run } = o;
  const to = process.env.MAIL_TO ?? '';
  const deliveryType = o.shadow ? 'shadow' : o.regenerate ? 'resend' : 'primary';
  const existing = db.prepare(`SELECT id, version, subject, text_body, html_body, digest_json FROM briefs
    WHERE run_id=? AND status='final' ORDER BY version DESC LIMIT 1`).get(run.id) as any;
  if (existing && !o.regenerate && db.prepare(`SELECT 1 FROM deliveries WHERE brief_id=? AND recipient=? AND delivery_type=? AND status='sent'`)
    .get(existing.id, to, deliveryType)) { console.log('本期已投递，不重复发送'); return 0; }

  let briefId: number, subject: string, html: string, text: string, data: DigestData;
  if (existing?.digest_json && !o.regenerate) {
    briefId = existing.id; subject = existing.subject; html = existing.html_body; text = existing.text_body;
    data = JSON.parse(existing.digest_json);
    console.log(`复用已生成的新版简报 #${briefId}（v${existing.version}）`);
  } else {
    // 统计实际 AI 调用次数（新版日报不写 evaluations，后台的「AI 判定」靠这里的计数）
    const inner = await createProvider(providerFromEnv('L1'));
    let aiCalls = 0;
    const provider: typeof inner = { get name() { return inner.name; }, get model() { return inner.model; }, get strictness() { return inner.strictness; },
      complete(req) { aiCalls++; return inner.complete(req); } };
    const tgEnabled = !!o.rules.brief?.telegram_daily?.enabled;
    const built = await buildDigest(db, o.win, provider, { telegramPath: tgEnabled ? (process.env.TELEGRAM_DATABASE_PATH ?? './data/telegram.sqlite3') : null });
    built.log.forEach(l => console.log(l));
    data = built.data;
    const tg = o.rules.brief?.telegram_daily;
    if (tg?.enabled) {
      data.telegram = await loadTelegramDaily(o.win.end, { waitMinutes: o.noSend ? 0 : Number(process.env.BRIEF_TELEGRAM_WAIT_MINUTES ?? tg.wait_minutes ?? 15), maxAgeHours: Number(tg.max_age_hours ?? 3), log: m => console.log(m) });
      if (data.telegram.status === 'ready') {
        const r = await stripDealsFromTelegram(provider, data.telegram, (data.tutorials ?? []).filter(t => t.category === 'deals'), built.log);
        data.telegram = r.tg;
        console.log(`Telegram 汇总去掉重复羊毛 ${r.removed.length} 条`);
      }
      console.log(`Telegram 群组要点：${data.telegram.status === 'ready' ? `${data.telegram.categories.reduce((n, c) => n + c.items.length, 0)} 条` : '未就绪，注明生成中'}`);
    }
    html = renderDigestHtml(data); text = renderDigestText(data);
    subject = digestSubject(data) + (o.regenerate ? '｜补发' : '');
    const errs = checkEmail(html, text);
    if (errs.length) { console.error('❌ 邮件校验未通过，拒绝发送：\n  ' + errs.join('\n  ')); return 1; }
    const prevAny = db.prepare(`SELECT max(version) v FROM briefs WHERE run_id=?`).get(run.id) as any;
    const version = (prevAny?.v ?? 0) + 1;
    briefId = Number(db.transaction(() => {
      const id = Number(db.prepare(`INSERT INTO briefs (run_id,version,subject,text_body,html_body,html_bytes,status,rule_version,created_at,digest_json)
        VALUES (?,?,?,?,?,?,'final',?,?,?)`).run(run.id, version, subject, text, html, Buffer.byteLength(html, 'utf8'),
        o.rules.meta.rule_version, nowIso(), JSON.stringify(data)).lastInsertRowid);
      if (existing) db.prepare(`UPDATE briefs SET status='superseded' WHERE id=?`).run(existing.id);
      db.prepare(`INSERT INTO audit_events (run_id,entity_type,entity_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)`)
        .run(run.id, 'brief', String(id), 'brief_composed', JSON.stringify({ format: 'digest_v2', items: digestCount(data), version, aiCalls, model: inner.model }), nowIso());
      return id;
    })());
    console.log(`已保存新版简报 #${briefId} v${version}：官方事件 ${data.vendors.reduce((n, v) => n + v.events.length, 0)} 条 / 开源项目 ${data.projects.length} 个`);
  }

  const rssOnly = o.rules.brief?.delivery === 'rss_only';
  if (rssOnly) {
    // 只发布 RSS：简报持久化即发布，同时登记 72 小时推送历史
    if (!o.shadow) recordPushed(db, briefId, data);
    console.log('delivery=rss_only：不发邮件，已通过 RSS 发布');
  } else if (o.noSend) console.log('--no-send：跳过投递');
  else if (!to) console.log('未设置 MAIL_TO，跳过投递');
  else {
    const { mailer, kind, note } = mailerFromEnv(o.outDir);
    console.log(`投递通道：${kind}${note ? ` —— ${note}` : ''}`);
    const r = await deliver(db, mailer, { briefId, recipient: to, assertEligible: () => {}, deliveryType,
      subject, text, html, environment: o.shadow ? 'shadow' : undefined });
    if ((r.status === 'sent' || r.status === 'already_sent') && !o.shadow) recordPushed(db, briefId, data);
    console.log(`投递 ${r.status}${r.providerId ? ` id=${r.providerId}` : ''}${r.error ? ` 错误：${r.error}` : ''}（尝试 ${r.attempts} 次）`);
    if (r.status === 'permanent_failure') { console.error('永久失败 —— 简报已持久化，修复凭证后可补发'); }
  }
  db.prepare(`UPDATE runs SET status='succeeded', stage='sending', finished_at=?, error=NULL WHERE id=?`).run(nowIso(), run.id);
  return 0;
}
