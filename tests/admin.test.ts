// 后台改版第一期：待处理事项、systemd 状态解析、日报 RSS、今日/系统页渲染、侧栏
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../packages/db/src/index.ts';
import { computeAlerts, readUnits, type AlertInput } from '../packages/web/src/ops.ts';
import { briefFeedToken, briefsRss, rotateBriefFeedToken } from '../packages/web/src/briefs-rss.ts';
import { renderSystem, renderToday, setNavBadges, layout } from '../packages/web/src/views.ts';
import { readyTelegramDb } from '../packages/telegram/src/db.ts';
import { addTelegramSource, renameTelegramSource } from '../packages/telegram/src/core.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  ' + d : ''}`); };
const now = Date.parse('2026-10-10T04:30:00Z');
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const healthy = (): AlertInput => ({
  now,
  units: [
    { id: 'brief-run', label: '完整日报运行', kind: 'oneshot', active: 'inactive', result: 'success', startedAt: now - 3 * 36e5, exitedAt: now - 3 * 36e5 + 577e3, nextAt: now + 6e5 },
    { id: 'brief-maintain', label: '维护与备份', kind: 'oneshot', active: 'inactive', result: 'success', startedAt: now - 9e6, exitedAt: now - 9e6 + 6e4, nextAt: now + 8e7 },
    { id: 'brief-telegram-collector', label: 'Telegram 采集', kind: 'daemon', active: 'active', result: 'success', startedAt: now - 9e6, exitedAt: null, nextAt: null },
  ],
  runs: [{ window_key: '2026-10-10:morning', window_label: '早报', scheduled_at: '2026-10-10T00:00:00.000Z', status: 'succeeded', error: null, finished_at: '2026-10-10T00:09:48.000Z' }],
  sources: [{ id: 'v2ex', display_name: 'V2EX', health: 'healthy', enabled: 1, consecutive_failures: 0 }],
  telegram: { authorized: true, heartbeatAt: iso(6e4), sources: [{ name: '折腾搞机', status: 'active', enabled: 1, last_error: null, last_success_at: iso(3e5) }],
    visionPaused: false, visionPauseReason: null, visionBacklog: 12, visionDailyLimit: 1000, failedSummaries: 0 },
  backups: [{ name: 'brief', label: '日报数据库', file: 'brief-2026-10-09.db.gz', bytes: 33 * 2 ** 20, mtime: now - 9e6 },
            { name: 'telegram', label: 'Telegram 数据库', file: 'telegram-2026-10-09.db.gz', bytes: 242 * 2 ** 20, mtime: now - 9e6 }],
  disk: { totalBytes: 34e9, usedBytes: 17.3e9, freeBytes: 16.7e9 },
});

console.log('待处理事项：\n');
{
  ok('一切正常时没有事项', computeAlerts(healthy()).length === 0);

  const i = healthy();
  i.runs.push({ window_key: '2026-10-09:evening', window_label: '晚报', scheduled_at: '2026-10-09T14:00:00.000Z', status: 'partial', error: 'L2/L3 复核无进展、简报组装', finished_at: null });
  const a = computeAlerts(i);
  ok('被完整性门禁拦下的时段 → 故障', a.length === 1 && a[0]!.level === 'bad' && a[0]!.title === '晚报未完成（10-09）' && a[0]!.detail.includes('复核无进展'), JSON.stringify(a));
  i.runs[1]!.scheduled_at = '2026-10-08T04:00:00.000Z';
  ok('超过 24 小时的旧失败不再提示', computeAlerts(i).length === 0);

  const t = healthy();
  t.telegram.sources = Array.from({ length: 16 }, (_, k) => ({ name: `频道${k}`, status: 'error', enabled: 0, last_error: '来源解析失败：ConnectionError', last_success_at: iso(864e6) }));
  const ta = computeAlerts(t);
  ok('9-29 全部来源被停用 → Telegram 故障', ta.some(x => x.area === 'telegram' && x.level === 'bad' && x.title === '16 个 Telegram 来源出错'), JSON.stringify(ta));

  const st = healthy(); st.telegram.sources[0]!.last_success_at = iso(2 * 36e5);
  ok('启用的来源超过 1 小时没同步 → 故障', computeAlerts(st).some(x => x.title === '1 个 Telegram 来源超过 1 小时没有同步'));
  const hb = healthy(); hb.telegram.heartbeatAt = iso(30 * 6e4);
  ok('采集器心跳超过 15 分钟 → 故障', computeAlerts(hb).some(x => x.title === 'Telegram 采集器没有心跳'));
  const na = healthy(); na.telegram.authorized = false;
  ok('账号未登录 → 故障', computeAlerts(na).some(x => x.title === 'Telegram 账号未登录'));

  const v = healthy(); v.telegram.visionPaused = true; v.telegram.visionPauseReason = '鉴权失败：请检查视觉模型 API 凭证后手动恢复队列';
  ok('图片识别暂停 → 故障并带原因', computeAlerts(v).some(x => x.title === '图片识别已暂停' && x.detail.includes('鉴权失败')));
  const vb = healthy(); vb.telegram.visionBacklog = 1959;
  const vba = computeAlerts(vb).find(x => x.title.startsWith('图片识别积压'));
  ok('积压超过每日上限 → 留意并估算天数', vba?.level === 'warn' && vba.title === '图片识别积压 1,959 张' && vba.detail.includes('约 2 天'), JSON.stringify(vba));

  const m = healthy(); m.units[1] = { ...m.units[1]!, result: 'timeout' }; m.backups[1]!.mtime = now - 6 * 864e5;
  const ma = computeAlerts(m);
  ok('维护超时 → 系统故障', ma.some(x => x.area === 'system' && x.title === '维护与备份上次运行失败' && x.detail.includes('timeout')));
  ok('备份超过 36 小时 → 系统故障', ma.some(x => x.title === 'Telegram 数据库超过 36 小时没有新备份'));
  const running = healthy(); running.units[1] = { ...running.units[1]!, active: 'activating', result: 'timeout' };
  ok('正在运行的任务不算失败', !computeAlerts(running).some(x => x.title.startsWith('维护与备份')));
  const dm = healthy(); dm.units[2] = { ...dm.units[2]!, active: 'failed' };
  ok('常驻服务停止 → 故障', computeAlerts(dm).some(x => x.title === 'Telegram 采集没有在运行'));

  const d = healthy(); d.disk = { totalBytes: 34e9, usedBytes: 30.6e9, freeBytes: 3.4e9 };
  ok('磁盘 90% → 留意', computeAlerts(d).some(x => x.level === 'warn' && x.title === '磁盘已用 90%'));
  d.disk = { totalBytes: 34e9, usedBytes: 33.7e9, freeBytes: 0.3e9 };
  ok('磁盘 99% → 故障', computeAlerts(d).some(x => x.level === 'bad' && x.title === '磁盘已用 99%'));

  const r = healthy(); r.sources.push({ id: 'x', display_name: 'X 来源', health: 'failing', enabled: 1, consecutive_failures: 7 });
  r.telegram.visionBacklog = 5000; r.runs.push({ ...healthy().runs[0]!, window_key: '2026-10-10:noon', window_label: '午报', status: 'failed' });
  const ra = computeAlerts(r);
  ok('故障排在留意前面', ra[0]!.level === 'bad' && ra[ra.length - 1]!.level === 'warn');
  ok('RSS 来源连续失败带次数', ra.some(x => x.area === 'sources' && x.detail.includes('X 来源（7 次）')));
}

console.log('\nsystemd 状态解析：\n');
{
  const out = [
    'Id=brief-run.service\nActiveState=inactive\nResult=success\nExecMainStartTimestamp=Sat 2026-10-10 00:00:10 UTC\nExecMainExitTimestamp=Sat 2026-10-10 00:09:48 UTC\nActiveEnterTimestamp=n/a\nNextElapseUSecRealtime=',
    'Id=brief-run.timer\nActiveState=active\nResult=success\nExecMainStartTimestamp=\nExecMainExitTimestamp=\nActiveEnterTimestamp=Fri 2026-10-02 10:00:00 UTC\nNextElapseUSecRealtime=Sat 2026-10-10 04:01:43 UTC',
    'Id=brief-telegram-collector.service\nActiveState=active\nResult=success\nExecMainStartTimestamp=Sat 2026-10-10 00:00:00 UTC\nExecMainExitTimestamp=\nActiveEnterTimestamp=Fri 2026-10-09 15:50:00 UTC\nNextElapseUSecRealtime=',
  ].join('\n\n');
  let args: string[] = [];
  const units = readUnits(a => { args = a; return out; });
  const run = units.find(u => u.id === 'brief-run')!;
  ok('使用 systemd 249 支持的 UTC 时间格式', args.includes('--timestamp=utc'));
  ok('一次查询所有服务和定时器', args.includes('brief-run.timer') && args.includes('brief-telegram-collector.service') && !args.includes('brief-telegram-collector.timer'));
  ok('解析上次运行与下次运行', run.startedAt === Date.parse('2026-10-10T00:00:10Z') && run.exitedAt === Date.parse('2026-10-10T00:09:48Z') && run.nextAt === Date.parse('2026-10-10T04:01:43Z') && run.result === 'success');
  ok('常驻服务取启动时间', units.find(u => u.id === 'brief-telegram-collector')!.startedAt === Date.parse('2026-10-09T15:50:00Z'));
  ok('间隔型定时器带说明文字', units.find(u => u.id === 'brief-subscriptions-sync')!.every === '每 5 分钟');
  ok('缺失的单元标为 unknown', units.find(u => u.id === 'brief-maintain')!.active === 'unknown');
  ok('systemctl 不可用时返回空数组', readUnits(() => { throw new Error('no dbus'); }).length === 0);
}

console.log('\n日报 RSS：\n');
const dir = mkdtempSync(join(tmpdir(), 'brief-admin-'));
{
  const db = openDb(join(dir, 'brief.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  const token = briefFeedToken(db);
  ok('迁移自动生成 256 位令牌', /^[a-f0-9]{64}$/.test(token ?? ''));
  const addRun = (key: string, label: string, start: string) => Number(db.prepare(`INSERT INTO runs(window_key,window_label,window_start_at,window_end_at,scheduled_at,status,trigger)
    VALUES(?,?,?,?,?,'succeeded','timer')`).run(key, label, start, start, start).lastInsertRowid);
  const addBrief = (run: number, version: number, subject: string, status = 'final') => Number(db.prepare(`INSERT INTO briefs(run_id,version,subject,text_body,html_body,html_bytes,status,rule_version,created_at)
    VALUES(?,?,?,?,?,?,?,1,?)`).run(run, version, subject, 't', `<h1>${subject}</h1><p>A & B</p>`, 10, status, '2026-10-10T00:09:00.000Z').lastInsertRowid);
  const r1 = addRun('2026-10-09:evening', '晚报', '2026-10-09T04:00:00.000Z');
  const r2 = addRun('2026-10-10:morning', '早报', '2026-10-09T14:00:00.000Z');
  addBrief(r1, 1, '十六源日报 · 10-09 晚报');
  addBrief(r2, 1, '早报 v1（被替换）', 'superseded'); const b2 = addBrief(r2, 2, '十六源日报 · 10-10 早报');
  addBrief(r2, 3, '草稿不发布', 'draft');
  db.prepare(`INSERT INTO deliveries(brief_id,recipient,delivery_type,status,created_at,sent_at) VALUES(?,'me@example.com','primary','sent',?,?)`)
    .run(b2, '2026-10-10T00:09:48.000Z', '2026-10-10T00:09:48.000Z');
  const feed = briefsRss(db, token!, 'https://rss.example')!;
  ok('每期一条，最新的在前', (feed.match(/<item>/g) ?? []).length === 2 && feed.indexOf('10-10 早报') < feed.indexOf('10-09 晚报'));
  ok('只取定稿的最新版本', !feed.includes('被替换') && !feed.includes('草稿不发布'));
  ok('正文是转义后的邮件 HTML', feed.includes('&lt;h1&gt;十六源日报 · 10-10 早报&lt;/h1&gt;&lt;p&gt;A &amp; B'));
  ok('发布时间取投递时间', feed.includes('<pubDate>Sat, 10 Oct 2026 00:09:48 GMT</pubDate>'));
  ok('错误令牌返回 null', briefsRss(db, 'f'.repeat(64), '') === null);
  const fresh = rotateBriefFeedToken(db);
  ok('重置后旧令牌立即失效', briefsRss(db, token!, '') === null && briefsRss(db, fresh!, '') !== null);
  rotateBriefFeedToken(db, true);
  ok('撤销后没有可用令牌', briefFeedToken(db) === null && briefsRss(db, fresh!, '') === null);
  db.close();
}

console.log('\n页面渲染：\n');
{
  setNavBadges(() => ({ today: { count: 2, level: 'bad' }, telegram: { count: 1, level: 'warn' } }));
  const page = renderToday({ csrf: 'c', now, dateLabel: '10月10日 周六',
    alerts: [{ level: 'bad', area: 'today', title: '午报未完成（10-10）', detail: '<script>x</script>', href: '/' }],
    slots: [
      { key: 'morning', label: '早报', clock: '08:00', scheduledAt: Date.parse('2026-10-10T00:00:00Z'),
        run: { status: 'succeeded', error: null, started_at: '2026-10-10T00:00:10.000Z', finished_at: '2026-10-10T00:09:48.000Z' }, items: 13,
        delivery: { status: 'sent', sent_at: '2026-10-10T00:09:48.000Z', error: null } },
      { key: 'noon', label: '午报', clock: '12:00', scheduledAt: Date.parse('2026-10-10T04:00:00Z'), run: null },
      { key: 'evening', label: '晚报', clock: '22:00', scheduledAt: Date.parse('2026-10-10T14:00:00Z'), run: null },
    ],
    rss: { healthy: 31, enabled: 33, lastHarvestAt: iso(6e5), lastHarvestNew: 12 },
    telegram: { active: 15, enabled: 15, messages24h: 3184, authorized: true },
    ai: { calls: 412 }, disk: healthy().disk, briefFeedUrl: 'https://rss.example/rss/briefs/abc' });
  ok('待处理事项转义不可信文本', page.includes('&lt;script&gt;x&lt;/script&gt;') && !page.includes('<script>x'));
  ok('早报已投递并显示用时与条数', page.includes('已投递') && page.includes('用时 9 分 38 秒') && page.includes('13 条'));
  ok('到点 30 分钟仍无记录 → 没有运行', page.includes('没有运行'));
  ok('未来时段显示未开始', page.includes('未开始'));
  ok('AI 只显示调用次数、不显示费用', page.includes('412 次') && !page.includes('$') && !page.includes('费用') && !page.includes(' token'));
  ok('显示日报 RSS 地址', page.includes('https://rss.example/rss/briefs/abc'));
  ok('侧栏高亮当前页并显示计数', page.includes('<a href="/" class="on" aria-current="page">今日<span class="cnt bad">2</span></a>') && page.includes('Telegram<span class="cnt warn">1</span>'));
  ok('页面不含任何脚本', !/<script/i.test(page.replace('&lt;script', '')));
  const quiet = renderToday({ ...({} as any), csrf: 'c', now, dateLabel: 'x', alerts: [], slots: [], rss: { healthy: 1, enabled: 1, lastHarvestAt: null, lastHarvestNew: null },
    telegram: { active: 0, enabled: 0, messages24h: 0, authorized: false }, ai: { calls: 0 }, disk: null, briefFeedUrl: null });
  ok('没有事项时明确说明', quiet.includes('没有需要处理的事项') && quiet.includes('令牌已撤销'));
  setNavBadges(() => { throw new Error('db locked'); });
  ok('侧栏计数出错不影响页面', layout('设置', '<p>x</p>', 'c').includes('class="on" aria-current="page">设置'));
  const sys = renderSystem({ csrf: 'c', now, units: [], backups: healthy().backups, disk: healthy().disk, ai24h: { calls: 0, byStage: [] } });
  ok('读不到 systemd 时给出排查方法', sys.includes('无法读取 systemd 状态'));
  const sys2 = renderSystem({ csrf: 'c', now, units: [], backups: [], disk: null, ai24h: { calls: 3, byStage: [{ stage: 'luna', model: 'm', calls: 3 }] } });
  ok('AI 环节显示中文名且无费用', sys2.includes('L1 初筛') && !sys2.includes('$'));
  ok('备份卡片显示大小', sys.includes('242 MB') && sys.includes('33 MB'));
}

console.log('\nTelegram 显示名：\n');
{
  const tg = readyTelegramDb(join(dir, 'telegram.db'));
  const src = addTelegramSource(tg, { reference: '@zaihuapd', sourceType: 'normal' });
  renameTelegramSource(tg, src.id, '  在花科技圈 ');
  ok('保存去掉首尾空格', (tg.prepare('SELECT display_name FROM telegram_sources WHERE id=?').get(src.id) as any).display_name === '在花科技圈');
  ok('留空回退为频道标题', (() => { renameTelegramSource(tg, src.id, ''); return (tg.prepare('SELECT display_name FROM telegram_sources WHERE id=?').get(src.id) as any).display_name === null; })());
  ok('超长显示名被拒绝', (() => { try { renameTelegramSource(tg, src.id, 'x'.repeat(81)); return false; } catch { return true; } })());
  ok('记录审计', !!tg.prepare("SELECT 1 FROM telegram_audit_events WHERE action='source_renamed'").get());
  tg.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
