// 固定窗口边界测试（PRD 5.1 / 23.1 / 24.1-P0）
// 本机 OS 时区是 UTC，窗口按 Asia/Taipei 判定，严格左闭右开。
import { windowOf } from '../packages/domain/src/normalize.ts';

const tp = (s: string) => new Date(`${s}+08:00`);   // 台北时刻
let fail = 0;

function expectWin(taipeiTime: string, key: string, label: string) {
  const w = windowOf(tp(taipeiTime));
  const ok = w.key === key && w.label === label;
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${taipeiTime}  → ${w.key} (${w.label})` +
              (ok ? '' : `   期望 ${key} (${label})`));
}

console.log('PRD 23.1 边界时刻（台北时间）：\n');
// 早报 = 前一天 22:00（含） ≤ t < 当天 08:00（不含）
expectWin('2026-08-22T21:59:59', '2026-08-22:evening', '晚报');
expectWin('2026-08-22T22:00:00', '2026-08-23:morning', '早报');   // 边界：进入次日早报
expectWin('2026-08-23T00:00:00', '2026-08-23:morning', '早报');
expectWin('2026-08-23T07:59:59', '2026-08-23:morning', '早报');
expectWin('2026-08-23T08:00:00', '2026-08-23:noon',    '午报');   // 边界：右开
expectWin('2026-08-23T11:59:59', '2026-08-23:noon',    '午报');
expectWin('2026-08-23T12:00:00', '2026-08-23:evening', '晚报');   // 边界：右开
expectWin('2026-08-23T21:59:59', '2026-08-23:evening', '晚报');
expectWin('2026-08-23T22:00:00', '2026-08-24:morning', '早报');

console.log('\n窗口区间正确性（左闭右开）：\n');
for (const [t, s, e] of [
  ['2026-08-23T03:00:00', '2026-08-22T22:00:00+08:00', '2026-08-23T08:00:00+08:00'],
  ['2026-08-23T09:00:00', '2026-08-23T08:00:00+08:00', '2026-08-23T12:00:00+08:00'],
  ['2026-08-23T15:00:00', '2026-08-23T12:00:00+08:00', '2026-08-23T22:00:00+08:00'],
] as const) {
  const w = windowOf(tp(t));
  const ok = w.start.getTime() === new Date(s).getTime() && w.end.getTime() === new Date(e).getTime();
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${t} → [${w.start.toISOString()}, ${w.end.toISOString()})`);
}

console.log('\nUTC 输入也必须得出同样结果（服务器跑在 UTC）：\n');
// 台北 2026-08-23 07:59:59 == UTC 2026-08-22 23:59:59
for (const [utc, key] of [
  ['2026-08-22T23:59:59Z', '2026-08-23:morning'],
  ['2026-08-23T00:00:00Z', '2026-08-23:noon'],      // 台北 08:00
  ['2026-08-23T04:00:00Z', '2026-08-23:evening'],   // 台北 12:00
  ['2026-08-23T14:00:00Z', '2026-08-24:morning'],   // 台北 22:00
] as const) {
  const w = windowOf(new Date(utc));
  const ok = w.key === key;
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${utc} → ${w.key}` + (ok ? '' : `   期望 ${key}`));
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
