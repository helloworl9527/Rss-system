// Telegram 跨频道汇总 RSS + 补采期间的窗口推进
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readyTelegramDb } from '../packages/telegram/src/db.ts';
import { rotateAllToken, updateTelegramSettings } from '../packages/telegram/src/core.ts';
import { digestRss } from '../packages/telegram/src/rss.ts';
import { ensureDueJobs } from '../packages/telegram/src/summarize.ts';
import { runDueDigests, validateDigest, TELEGRAM_DIGEST_SCHEMA } from '../packages/telegram/src/digest.ts';
import { cleanupTelegram } from '../packages/telegram/src/maintenance.ts';

const dir = mkdtempSync(join(tmpdir(), 'brief-tg-digest-')); const db = readyTelegramDb(join(dir, 'telegram.db'));
let fail = 0; const ok = (name: string, value: boolean, d = '') => { if (!value) fail++; console.log(`  ${value ? '✅' : '❌'} ${name}${d ? '  ' + d : ''}`); };

updateTelegramSettings(db, { timezone: 'UTC', schedule: '00:00,12:00', provider: 'mock', model: 'm', credentialRef: 'OPENAI_COMPAT_API_KEY', promptRules: '' });
const allToken = rotateAllToken(db)!;
const T = (s: string) => new Date(s).toISOString();
const now = new Date('2026-10-09T13:00:00Z');
const addSource = (title: string, chatId: number) => {
  const id = Number(db.prepare(`INSERT INTO telegram_sources(reference,source_type,chat_id,title,status,enabled,validation_requested_at,created_at,updated_at)
    VALUES(?,'normal',?,?,'active',1,?,?,?)`).run(`@s${chatId}`, chatId, title, T('2026-10-01'), T('2026-10-01'), T('2026-10-01')).lastInsertRowid);
  db.prepare('INSERT INTO telegram_sync_state(source_id) VALUES(?)').run(id);
  return id;
};
const a = addSource('折腾搞机', -101), b = addSource('eSIM群', -102), c = addSource('giffgaff 交流群', -103);
const W = T('2026-10-09T12:00:00Z'), W0 = T('2026-10-09T00:00:00Z');
const addSummary = (sourceId: number, start: string, end: string, summary: object) => {
  const job = db.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at)
    VALUES(?,?,?,'h','mock','m',1,'completed',?,?)`).run(sourceId, start, end, end, end);
  db.prepare(`INSERT INTO telegram_summaries(job_id,source_id,window_start,window_end,title,summary_json,rendered_html,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(job.lastInsertRowid, sourceId, start, end, 't', JSON.stringify(summary), '', end, T('2026-11-30'));
};
const S = (topic: string) => ({ topics: [topic], important: [`${topic} 的细节`], viewpoints: [`${topic} 的看法`], sources: [], uncertainty: [] });
addSummary(a, W0, W, S('iPhone eSIM'));
addSummary(b, W0, W, S('eSIM 开通'));

let calls = 0; let lastPrompt = '';
const provider = { name: 'mock', model: 'digest-m', strictness: 'strict', complete: async (req: any) => {
  calls++; lastPrompt = req.userContent;
  return { data: { points: [
    { text: '国行 iPhone 添加 eSIM 受限（消息 ID：123）', channels: ['eSIM群', '折腾搞机', '编造频道'], unverified: false },
    { text: '凭空编造的要点', channels: ['不存在的频道'], unverified: false },
    { text: '有人提出绕过方法仍然有效', channels: ['折腾搞机'], unverified: true },
  ] },
    rawText: '', responseId: 'r', model: 'digest-m', usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 } };
} } as any;
const cfg = { provider: 'mock' as const, model: 'm', summaryRetentionDays: 30, lookbackDays: 7 };

console.log('等待所有频道就绪：\n');
{
  db.prepare('UPDATE telegram_sync_state SET last_window_end=? WHERE source_id IN (?,?)').run(W, a, b);
  db.prepare('UPDATE telegram_sync_state SET last_window_end=? WHERE source_id=?').run(W0, c);
  ok('有频道还没推进到该时刻时不生成', await runDueDigests(db, cfg, provider, now) === 0 && calls === 0);
  ok('超过宽限期后不再等落后的频道', await runDueDigests(db, cfg, provider, new Date('2026-10-09T15:30:00Z')) === 1);
  db.prepare('DELETE FROM telegram_digests').run(); calls = 0;
  db.prepare('UPDATE telegram_sync_state SET last_window_end=? WHERE source_id=?').run(W, c);
  const pending = db.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at)
    VALUES(?,?,?,'','mock','m',1,'pending',?,?)`).run(c, W0, W, W, W);
  ok('同一时刻还有频道总结未完成时不生成', await runDueDigests(db, cfg, provider, now) === 0 && calls === 0);
  db.prepare('DELETE FROM telegram_summary_jobs WHERE id=?').run(pending.lastInsertRowid);
}

console.log('\nAI 合并与来源频道：\n');
{
  ok('全部就绪后生成一条汇总', await runDueDigests(db, cfg, provider, now) === 1 && calls === 1);
  ok('提示词只列出本时段有总结的频道', lastPrompt.includes('["折腾搞机","eSIM群"]') && !lastPrompt.includes('giffgaff'));
  const row = db.prepare('SELECT * FROM telegram_digests WHERE window_end=?').get(W) as any;
  const html = String(row.rendered_html);
  ok('编号清单，每条下方标注来源频道（按输入顺序）', html.startsWith('<ol><li><p>国行 iPhone 添加 eSIM 受限<br>— 折腾搞机、eSIM群</p></li>'), html.slice(0, 160));
  ok('丢弃编造的频道名', !html.includes('编造频道'));
  ok('没有有效频道的要点整条丢弃', !html.includes('凭空编造的要点') && (html.match(/<li>/g) ?? []).length === 2);
  ok('清理消息 ID', !html.includes('123'));
  ok('未证实要点标注待核实并清理引导语', html.includes('<li><p>绕过方法仍然有效（待核实）<br>— 折腾搞机</p></li>'), html);
  ok('末尾列出涉及频道', html.endsWith('<p>涉及频道：折腾搞机、eSIM群</p>'));
  ok('记录来源与模型', row.source_ids === JSON.stringify([a, b]) && row.response_model === 'digest-m' && row.fallback === 0);
  ok('已完成的时刻不重复调用', await runDueDigests(db, cfg, provider, now) === 0 && calls === 1);
  ok('Schema 最多 10 条、每条至少一个频道', (TELEGRAM_DIGEST_SCHEMA.properties.points as any).maxItems === 10 &&
    (TELEGRAM_DIGEST_SCHEMA.properties.points as any).items.properties.channels.minItems === 1);
  ok('超过 10 条时截断', validateDigest({ points: Array.from({ length: 15 }, (_, i) => ({ text: `p${i}`, channels: ['折腾搞机'] })) }, ['折腾搞机']).points.length === 10);
}

console.log('\n汇总 RSS：\n');
{
  const feed = digestRss(db, allToken, 'https://brief.test')!;
  ok('每个时刻一条 item', (feed.match(/<item>/g) ?? []).length === 1);
  ok('标题含月日与早/午/晚', feed.includes('<title>📌 Telegram 要点 · 10-09 午</title>'));
  ok('guid 稳定', feed.includes('telegram-digest:2026-10-09T12:00:00.000Z'));
  ok('正文含来源频道标注', feed.includes('— 折腾搞机、eSIM群'));
  ok('错误令牌返回 null', digestRss(db, 'f'.repeat(64), '') === null);
}

console.log('\n单频道与 AI 失败兜底：\n');
{
  const W2 = T('2026-10-09T00:00:00Z'), W1 = T('2026-10-08T12:00:00Z');
  addSummary(c, W1, W2, S('giffgaff 激活'));
  calls = 0;
  ok('只有一个频道时不调用 AI，直接标注该频道', await runDueDigests(db, cfg, provider, now) === 1 && calls === 0 &&
    String((db.prepare('SELECT rendered_html FROM telegram_digests WHERE window_end=?').get(W2) as any).rendered_html).includes('giffgaff 激活 的细节<br>— giffgaff 交流群'));

  const W3 = T('2026-10-08T12:00:00Z'), W4 = T('2026-10-08T00:00:00Z');
  addSummary(a, W4, W3, S('A 话题')); addSummary(b, W4, W3, S('B 话题'));
  const broken = { name: 'mock', model: 'm', strictness: 'strict', complete: async () => { throw new Error('upstream down'); } } as any;
  let t = now;
  ok('AI 失败先排队重试', await runDueDigests(db, cfg, broken, t) === 0 &&
    (db.prepare('SELECT status,next_attempt_at FROM telegram_digests WHERE window_end=?').get(W3) as any).status === 'failed');
  ok('未到重试时间不重试', await runDueDigests(db, cfg, broken, t) === 0 &&
    (db.prepare('SELECT attempts FROM telegram_digests WHERE window_end=?').get(W3) as any).attempts === 1);
  t = new Date(t.getTime() + 3600_000); await runDueDigests(db, cfg, broken, t);
  t = new Date(t.getTime() + 3600_000); await runDueDigests(db, cfg, broken, t);
  const fb = db.prepare('SELECT * FROM telegram_digests WHERE window_end=?').get(W3) as any;
  ok('第 3 次失败后退回逐频道拼接，时段不缺席', fb.status === 'completed' && fb.fallback === 1 && fb.attempts === 3 && String(fb.error).includes('upstream down'));
  ok('兜底取各频道重要信息并轮流排列、标注频道', String(fb.rendered_html).startsWith('<ol><li><p>A 话题 的细节<br>— 折腾搞机</p></li><li><p>B 话题 的细节<br>— eSIM群</p></li></ol>'), String(fb.rendered_html));
}

console.log('\n补采未覆盖的窗口不推进：\n');
{
  // 2026-10-09：补采还没跑到时窗口看起来是空的，旧逻辑直接推进边界，补回来的消息永远进不了总结
  const d = addSource('补采中的群', -104);
  db.prepare('UPDATE telegram_sync_state SET last_window_end=? WHERE source_id=?').run(T('2026-10-08T12:00:00Z'), d);
  db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`)
    .run(d, -104, 1, T('2026-10-09T06:00:00Z'), '补采回来的消息', 'h', T('2026-10-09T13:00:00Z'));
  const jobs = () => db.prepare('SELECT window_start,window_end FROM telegram_summary_jobs WHERE source_id=?').all(d) as any[];
  const cursor = () => (db.prepare('SELECT last_window_end FROM telegram_sync_state WHERE source_id=?').get(d) as any).last_window_end;
  ensureDueJobs(db, now);
  ok('从未成功同步过的来源不推进', jobs().length === 0 && cursor() === T('2026-10-08T12:00:00Z'));
  db.prepare('UPDATE telegram_sources SET last_success_at=? WHERE id=?').run(T('2026-10-09T11:00:00Z'), d);
  ensureDueJobs(db, now);
  ok('只推进到采集已覆盖的边界', jobs().length === 0 && cursor() === T('2026-10-09T00:00:00Z'), cursor());
  db.prepare('UPDATE telegram_sources SET last_success_at=? WHERE id=?').run(T('2026-10-09T12:30:00Z'), d);
  ensureDueJobs(db, now);
  ok('采集覆盖后为补回的消息建总结任务', jobs().length === 1 && jobs()[0].window_end === W && cursor() === W);
}

console.log('\n保留期清理：\n');
{
  db.prepare("UPDATE telegram_digests SET expires_at=? WHERE window_end=?").run(T('2026-10-01'), W);
  cleanupTelegram(db, now);
  ok('过期汇总被清理', !db.prepare('SELECT 1 FROM telegram_digests WHERE window_end=?').get(W));
  ok('integrity_check=ok', db.pragma('integrity_check', { simple: true }) === 'ok');
}

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过'); process.exit(fail ? 1 : 0);
