// Telegram 群组每日要点（daily_v2）：分块提取 → 按分类合并，不设条数上限
import assert from 'node:assert/strict';
import { isDaily, chunkMessages, composeDaily, normalizeCategory, renderDailyHtml, renderDailyMarkdown, dailyCount } from '../packages/telegram/src/daily.ts';
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
console.log('telegram-daily: all passed');
