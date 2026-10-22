// Telegram 群组每日要点（daily_v2）：分块提取 → 按分类合并，不设条数上限
import assert from 'node:assert/strict';
import { chunkMessages, composeDaily, normalizeCategory, renderDailyHtml, renderDailyMarkdown, dailyCount } from '../packages/telegram/src/daily.ts';
import { TELEGRAM_DIGEST_SCHEMA, validateDigest, fallbackDigest } from '../packages/telegram/src/digest.ts';

assert.equal(normalizeCategory('eSIM'), 'eSIM/保号');
assert.equal(normalizeCategory(' 银行/支付 '), '银行/支付');
assert.equal(normalizeCategory(''), '其他');
assert.equal(chunkMessages([{ text: 'a'.repeat(900) }, { text: 'b'.repeat(900) }, { text: 'c' }], 1200).length, 2);
assert.equal((TELEGRAM_DIGEST_SCHEMA.properties.points as any).maxItems, undefined, '取消 10 条上限');
assert.equal(validateDigest({ points: Array.from({ length: 25 }, (_, i) => ({ text: `要点${i}`, detail: '', channels: ['A'] })) }, ['A']).points.length, 25);
assert.equal(fallbackDigest([{ sourceId: 1, channel: 'A', windowStart: '', summary: { important: Array.from({ length: 15 }, (_, i) => `x${i}`) } }]).points.length, 15);

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
console.log('telegram-daily: all passed');
