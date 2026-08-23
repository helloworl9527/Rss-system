// 固定窗口边界（PRD 5.1 / 23.1 / 24.1-P0）
// 本机 OS 时区是 UTC，窗口按 Asia/Taipei 判定，严格左闭右开。
// 窗口时刻来自 rules.yaml windows.schedule —— 改配置后本测试必须同步更新。
import { windowOf, windowFromKey, previousWindows, windowToReport } from '../packages/domain/src/normalize.ts';
import { loadRules } from '../packages/domain/src/rules.ts';

const tp = (s: string) => new Date(`${s}+08:00`);
let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

const sch = loadRules().windows.schedule as Array<{ id: string; label: string; end_hour: number }>;
const H = Object.fromEntries(sch.map(s => [s.id, s.end_hour])) as Record<string, number>;
console.log(`窗口配置：${sch.map(s => `${s.label} →${s.end_hour}:00`).join('  ')}\n`);

function expectWin(taipeiTime: string, key: string) {
  const w = windowOf(tp(taipeiTime));
  const okk = w.key === key;
  if (!okk) fail++;
  console.log(`  ${okk ? '✅' : '❌'} ${taipeiTime} → ${w.key} (${w.label})${okk ? '' : `   期望 ${key}`}`);
}

// 由配置推导边界时刻，配置改了测试自动跟随
const pad = (n: number) => String(n).padStart(2, '0');
const before = (h: number) => `${pad(h - 1)}:59:59`;
const at = (h: number) => `${pad(h)}:00:00`;

console.log('各窗口结束时刻的前后一秒（左闭右开）：\n');
expectWin(`2026-08-22T${before(H.evening!)}`, '2026-08-22:evening');
expectWin(`2026-08-22T${at(H.evening!)}`,     '2026-08-23:morning');   // 跨日
expectWin('2026-08-23T00:00:00',              '2026-08-23:morning');
expectWin(`2026-08-23T${before(H.morning!)}`, '2026-08-23:morning');
expectWin(`2026-08-23T${at(H.morning!)}`,     '2026-08-23:noon');
expectWin(`2026-08-23T${before(H.noon!)}`,    '2026-08-23:noon');
expectWin(`2026-08-23T${at(H.noon!)}`,        '2026-08-23:evening');
expectWin(`2026-08-23T${before(H.evening!)}`, '2026-08-23:evening');
expectWin(`2026-08-23T${at(H.evening!)}`,     '2026-08-24:morning');

console.log('\n窗口区间首尾相接、覆盖全天：\n');
{
  const day = '2026-08-23';
  const wins = sch.map(s => windowFromKey(`${day}:${s.id}`));
  let contiguous = true;
  for (let i = 1; i < wins.length; i++)
    if (wins[i]!.start.getTime() !== wins[i - 1]!.end.getTime()) contiguous = false;
  ok('相邻窗口首尾相接', contiguous,
     wins.map(w => `${w.start.toISOString().slice(11, 16)}–${w.end.toISOString().slice(11, 16)}`).join(' '));
  const nextMorning = windowFromKey(`${'2026-08-24'}:${sch[0]!.id}`);
  ok('末窗口结束 = 次日首窗口开始（跨日闭合）',
     nextMorning.start.getTime() === wins[wins.length - 1]!.end.getTime());
  const total = wins.reduce((n, w) => n + (w.end.getTime() - w.start.getTime()), 0);
  ok('三窗口合计 24 小时', total === 24 * 3600e3, (total / 3600e3) + ' 小时');
}

console.log('\nUTC 输入也必须得出同样结果（服务器跑在 UTC）：\n');
{
  const toUtc = (h: number) => (h - 8 + 24) % 24;
  expectWin(`2026-08-23T${at(H.morning!)}`, '2026-08-23:noon');
  const w = windowOf(new Date(`2026-08-23T${pad(toUtc(H.morning!))}:00:00Z`));
  ok(`UTC ${pad(toUtc(H.morning!))}:00 = 台北 ${at(H.morning!)}`, w.key === '2026-08-23:noon', w.key);
  const w2 = windowOf(new Date(`2026-08-23T${pad(toUtc(H.evening!))}:00:00Z`));
  ok(`UTC ${pad(toUtc(H.evening!))}:00 = 台北 ${at(H.evening!)}`, w2.key === '2026-08-24:morning', w2.key);
}

console.log('\n最近三个已结束窗口：\n');
{
  const cur = windowOf(tp('2026-08-23T09:00:00'));
  const prev = previousWindows(cur, 3);
  ok('当前为午报', cur.key === '2026-08-23:noon', cur.key);
  ok('前三个由近及远',
     prev.map(p => p.key).join(' ') === '2026-08-23:morning 2026-08-22:evening 2026-08-22:noon',
     prev.map(p => p.key).join(' '));
  ok('每个都已结束（end ≤ 当前窗口 start）',
     prev.every(p => p.end.getTime() <= cur.start.getTime()));
}

console.log('\n发报时刻应报「刚结束」的窗口，而非刚开始的：\n');
{
  // 真实踩过的坑：timer 在窗口 end 时刻触发，而窗口左闭右开，
  // 此刻 windowOf() 返回的是刚开始的下一个窗口 —— 直接用会让
  // 每期简报覆盖尚未发生的空窗口，且日期显示为次日。
  const cases: Array<[string, string, string]> = [
    [`2026-08-23T${at(H.morning!)}`, '2026-08-23:morning', '早报'],
    [`2026-08-23T${at(H.noon!)}`,    '2026-08-23:noon',    '午报'],
    [`2026-08-23T${at(H.evening!)}`, '2026-08-23:evening', '晚报'],
  ];
  for (const [t, wantKey, label] of cases) {
    const w = windowToReport(tp(t));
    ok(`${t.slice(11)} 发报 → ${label} ${wantKey}`, w.key === wantKey, w.key);
    ok(`  该窗口已完整结束`, w.end.getTime() <= tp(t).getTime());
  }
  // 对照：windowOf 在同一时刻返回的是下一个窗口
  ok('windowOf 在边界返回下一个窗口（这正是需要 windowToReport 的原因）',
     windowOf(tp(`2026-08-23T${at(H.evening!)}`)).key === '2026-08-24:morning');
}
{
  // 手工在窗口中途运行：取上一个完整窗口，不出半截内容
  const w = windowToReport(tp('2026-08-23T15:00:00'));
  ok('窗口中途运行 → 取上一个完整窗口', w.key === '2026-08-23:noon', w.key);
  ok('  取到的窗口已结束', w.end.getTime() < tp('2026-08-23T15:00:00').getTime());
}

console.log('\n跨年跨月边界：\n');
for (const [k, want] of [
  ['2026-01-01:morning', '2025-12-31'],
  ['2026-03-01:morning', '2026-02-28'],
] as const) {
  const w = windowFromKey(k);
  ok(`${k} 起点落在 ${want}`, w.start.toISOString().startsWith(want) ||
     new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(w.start) === want,
     new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(w.start));
}

console.log('\n非法输入：\n');
{
  const bad = (k: string) => { try { windowFromKey(k); return false; } catch { return true; } };
  ok('未知窗口 id 被拒', bad('2026-08-23:midnight'));
  ok('非法日期被拒', bad('not-a-date:morning'));
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
