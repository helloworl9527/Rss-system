#!/usr/bin/env node
/**
 * 只渲染预览（不写库、不发信、不登记推送历史）。
 *
 *   node apps/worker/src/preview.ts                    最近一个已结束窗口
 *   node apps/worker/src/preview.ts --window 2026-10-22:noon
 *   node apps/worker/src/preview.ts --out /tmp/preview  输出目录（默认 ./data/preview）
 *
 * 数据库以只读方式打开：不会生成 brief 版本、不会作废旧版本、不会写 deliveries /
 * appendix_seen / pushed_* / audit_events。模型调用照常发生（需要真实摘要）。
 */
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hydrateEnv } from '../../../packages/web/src/secrets.ts';
import { windowFromKey, windowToReport } from '../../../packages/domain/src/normalize.ts';
import { createProvider, providerFromEnv } from '../../../packages/ai/src/registry.ts';
import { buildDigest } from '../../../packages/digest/src/build.ts';
import { loadTelegramDaily } from '../../../packages/digest/src/telegram.ts';
import { loadRules } from '../../../packages/domain/src/rules.ts';
import { renderDigestHtml, renderDigestText, renderDigestFeedHtml, digestSubject } from '../../../packages/digest/src/render.ts';
import { checkEmail } from '../../../packages/templates/src/email.ts';

const argv = process.argv.slice(2);
const arg = (k: string) => argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined;
const vault = hydrateEnv();
if (vault.error) console.warn(`密钥保管库不可用：${vault.error}`);

const db = new Database(process.env.DATABASE_PATH ?? './data/brief.db', { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
const win = arg('--window') ? windowFromKey(arg('--window')!) : windowToReport();
const out = arg('--out') ?? './data/preview';
const provider = await createProvider(providerFromEnv('L1'));

console.log(`预览 ${win.key} ${win.label} [${win.start.toISOString()} → ${win.end.toISOString()}) 模型 ${provider.name}/${provider.model}`);
const { data, log } = await buildDigest(db as any, win, provider);
db.close();
log.forEach(l => console.log(l));
const tgCfg = (loadRules() as any).brief?.telegram_daily;
if (arg('--telegram-json')) {
  // 试运行生成的群组要点（未写库），用于预览完整日报
  const d = JSON.parse(readFileSync(arg('--telegram-json')!, 'utf8'));
  data.telegram = { status: 'ready', windowStart: d.windowStart, windowEnd: d.windowEnd, categories: d.categories, groups: d.groups };
} else if (tgCfg?.enabled && !argv.includes('--no-telegram')) {
  data.telegram = await loadTelegramDaily(win.end, { waitMinutes: 0, maxAgeHours: Number(tgCfg.max_age_hours ?? 3) });
  console.log(`Telegram 群组要点：${data.telegram.status}`);
}

const html = renderDigestHtml(data), text = renderDigestText(data);
const errs = checkEmail(html, text);
if (errs.length) console.warn('⚠️ 邮件校验问题：\n  ' + errs.join('\n  '));
mkdirSync(out, { recursive: true });
const base = join(out, `preview-${win.key.replace(':', '-')}`);
writeFileSync(`${base}.html`, html);
writeFileSync(`${base}.txt`, `主题：${digestSubject(data)}\n\n${text}`);
writeFileSync(`${base}.rss.html`, `<!doctype html><meta charset="utf-8"><title>${digestSubject(data)}（RSS 正文）</title><h1>${digestSubject(data)}</h1>${renderDigestFeedHtml(data)}`);
writeFileSync(`${base}.json`, JSON.stringify(data, null, 2));
console.log(`✅ 预览已写入 ${base}.html / .txt / .json（未写库、未发送）`);
