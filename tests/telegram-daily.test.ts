// Telegram 群组每日要点（daily_v2）：分块提取 → 按分类合并，不设条数上限
import assert from 'node:assert/strict';
import { isDaily, chunkMessages, composeDaily, normalizeCategory, renderDailyHtml, renderDailyMarkdown, dailyCount } from '../packages/telegram/src/daily.ts';
import { collapseDuplicateMessages } from '../packages/telegram/src/core.ts';
import { ProviderError } from '../packages/ai/src/types.ts';
import { TELEGRAM_DIGEST_SCHEMA, validateDigest, fallbackDigest } from '../packages/telegram/src/digest.ts';

assert.equal(normalizeCategory('eSIM'), 'eSIM/保号');
assert.equal(normalizeCategory(' 银行/支付 '), '银行/支付');
assert.equal(normalizeCategory(''), '其他');
assert.equal(chunkMessages([{ text: 'a'.repeat(900) }, { text: 'b'.repeat(900) }, { text: 'c' }], 1200).length, 2);
assert.equal((TELEGRAM_DIGEST_SCHEMA.properties.points as any).maxItems, undefined, '取消 10 条上限');
assert.equal(validateDigest({ points: Array.from({ length: 25 }, (_, i) => ({ text: `要点${i}`, detail: '', channels: ['A'] })) }, ['A']).points.length, 25);
{
  const fb = fallbackDigest([{ sourceId: 1, channel: 'A', windowStart: '', summary: { important: Array.from({ length: 15 }, (_, i) => `x${i}`) } },
    { sourceId: 2, channel: 'B', windowStart: '', summary: { important: [], topics: ['t1'] } }], 's', 'e', ['说明']);
  assert.equal(fb.format, 'daily_v2'); assert.equal(isDaily(fb), true);
  assert.equal(dailyCount(fb), 16); assert.deepEqual(fb.groups, ['A', 'B']); assert.deepEqual(fb.notes, ['说明']);
  assert.ok(renderDailyHtml(fb).includes('<h3>B</h3>') && renderDailyHtml(fb).includes('<small>说明</small>'));
}

const calls: string[] = [];
const fake: any = { name: 'mock', model: 'm', strictness: 'strict', async complete(req: any) {
  calls.push(req.schemaName);
  if (req.schemaName === 'tg_extract') {
    const n = (req.userContent.match(/<message /g) ?? []).length;
    const group = /群：(.*)/.exec(req.userContent)![1];
    return { data: { points: Array.from({ length: n }, (_, i) => ({ category: i % 2 ? 'eSIM' : '会员订阅/优惠', text: `${group} 要点 ${i}，价格 5 美元。` })) }, usage: {}, responseId: 'r', model: 'm' };
  }
  const list = JSON.parse(req.userContent.slice(req.userContent.indexOf('\n\n') + 2));
  return { data: { items: list.map((x: any) => ({ text: x.text, groups: [...x.groups, '编造群'] })) }, usage: {}, responseId: 'r', model: 'm' };
} };
const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ message_id: i + 1, sent_at: '2026-10-21T00:00:00Z', reply_to_id: null, text: 'x'.repeat(500) }));
const d = await composeDaily(fake, [{ group: 'A群', messages: msgs(30) }, { group: 'B群', messages: msgs(3) }], 's', 'e', { maxChars: 3000 });
assert.ok(calls.filter(c => c === 'tg_extract').length > 2, '按群分块提取');
assert.ok(calls.includes('tg_merge'), '按分类合并');
assert.equal(dailyCount(d), 33, '不丢要点、无上限');
assert.deepEqual(d.categories.map(c => c.name), ['会员订阅/优惠', 'eSIM/保号'], '按建议分类顺序');
assert.ok(d.categories.every(c => c.items.every(i => !i.groups.includes('编造群'))), '来源群只能取输入中的群');
assert.ok(renderDailyHtml(d).includes('<h3>eSIM/保号</h3>') && renderDailyMarkdown(d).includes('〔A群〕'));

// 单群提取失败：跳过并标注，其余群照常；全部失败才抛错
process.env.TELEGRAM_DAILY_RETRY_MS = '0';
const flaky: any = { ...fake, async complete(req: any) {
  if (req.schemaName === 'tg_extract' && /群：B群/.test(req.userContent)) throw new Error('响应不是合法 JSON（响应体为空）');
  return fake.complete(req);
} };
const d2 = await composeDaily(flaky, [{ group: 'A群', messages: msgs(3) }, { group: 'B群', messages: msgs(3) }], 's', 'e');
assert.equal(dailyCount(d2), 3, '只保留 A 群');
assert.deepEqual(d2.notes, ['B群 群本期生成失败']);
assert.ok(renderDailyHtml(d2).includes('B群 群本期生成失败'));
const dead: any = { ...fake, async complete() { throw new Error('down'); } };
await assert.rejects(() => composeDaily(dead, [{ group: 'A群', messages: msgs(2) }, { group: 'B群', messages: msgs(2) }], 's', 'e'), /down/);

// 内容被模型过滤：不重试、跳过该块，并与「生成失败」区分标注
{
  const filteredErr = () => { const e = new ProviderError('bad_request', '内容被模型过滤（响应无 choices，补全 0 token）'); e.contentFiltered = true; return e; };
  let extractCalls: Record<string, number> = {};
  const prov: any = { ...fake, async complete(req: any) {
    if (req.schemaName === 'tg_extract') {
      const group = /群：(.*)/.exec(req.userContent)![1]!; extractCalls[group] = (extractCalls[group] ?? 0) + 1;
      if (group === 'F群') throw filteredErr();
      if (group === 'G群') throw new Error('响应不是合法 JSON（响应体为空）');
      if (group === 'P群' && /分块 2\//.test(req.userContent)) throw filteredErr();
    }
    return fake.complete(req);
  } };
  const big = (n: number) => Array.from({ length: n }, (_, i) => ({ message_id: i + 1, sent_at: '2026-10-21T00:00:00Z', reply_to_id: null, text: 'y'.repeat(500) + i }));
  const d3 = await composeDaily(prov, [{ group: 'A群', messages: msgs(3) }, { group: 'F群', messages: msgs(3) }, { group: 'G群', messages: msgs(3) },
    { group: 'P群', messages: big(8) }], 's', 'e', { maxChars: 3000 });
  assert.equal(extractCalls['F群'], 1, '被过滤的块不重试');
  assert.equal(extractCalls['G群'], 3, '普通失败仍重试 3 次');
  assert.deepEqual(d3.notes, ['F群 群本期内容被模型过滤', 'G群 群本期生成失败', 'P群 群部分内容被模型过滤']);
  assert.ok(dailyCount(d3) > 0 && d3.categories.every(c => c.items.every(i => !i.groups.includes('F群'))));
}

// 同窗口完全相同消息折叠成一条并标 ×N
{
  const rows = [
    { message_id: 1, sent_at: 't1', reply_to_id: null, text: '广告 A' },
    { message_id: 2, sent_at: 't2', reply_to_id: null, text: '正常讨论 1' },
    { message_id: 3, sent_at: 't3', reply_to_id: null, text: '  广告   A\n' },      // 空白差异，规范化后相同
    { message_id: 4, sent_at: 't4', reply_to_id: 3, text: '回复被折叠的消息' },
    { message_id: 5, sent_at: 't5', reply_to_id: null, text: '广告 A' },
    { message_id: 6, sent_at: 't6', reply_to_id: null, text: '广告 B' },
  ];
  const out = collapseDuplicateMessages(rows, m => m.text, (m, text) => ({ ...m, text }));
  assert.deepEqual(out.map(m => m.message_id), [1, 2, 4, 6], '保留首次出现，其余顺序不变');
  assert.equal(out[0]!.text, '广告 A\n（×3）'); assert.equal(out[0]!.sent_at, 't1');
  assert.equal(out[1]!.text, '正常讨论 1', 'N=1 不加标注');
  assert.equal(out[2]!.reply_to_id, 1, '回复被折叠消息时指向保留的那条');
  assert.equal(out[3]!.text, '广告 B');
  assert.equal(rows[0]!.text, '广告 A', '不修改输入');
}
console.log('telegram-daily: all passed');
