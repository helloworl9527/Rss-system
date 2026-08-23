// 确定性过滤回归（PRD 8.3 / 23.1）
import { applyDeterministicFilters, assertReasonAllowed } from '../packages/domain/src/filters.ts';
import type { SignalMap } from '../packages/domain/src/signals.ts';

const S = (o: Partial<SignalMap> = {}): SignalMap => ({
  repo_url: false, demo_link: false, official_link: false, external_link: false,
  code_block: false, command_line: false, config_block: false, install_hint: false,
  policy_mention: false, price_mention: false, invite_code: false, step_markers: false,
  aff_link: false, ...o,
});
const base = {
  title: '标题', cleanText: 'x'.repeat(500), signals: S(), externalLinkCount: 2,
  isMandatory: false, alreadySentNoUpdate: false, duplicateCanonical: false,
};
let fail = 0;
const check = (name: string, ctx: any, expect: string | null) => {
  const r = applyDeterministicFilters({ ...base, ...ctx });
  const got = r?.ruleId ?? null;
  const ok = got === expect;
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(40)} → ${got ?? '不过滤'}${ok ? '' : `  期望 ${expect ?? '不过滤'}`}`);
};

console.log('确定性过滤：\n');
check('正常内容不被过滤', {}, null);
check('空标题', { title: '' }, 'DF-002');
check('空正文', { cleanText: '短' }, 'DF-002');
check('已发送且无更新', { alreadySentNoUpdate: true }, 'DF-001');
check('追踪参数重复', { duplicateCanonical: true }, 'DF-003');
check('密钥泄露', { cleanText: '这是我的 key sk-abcdefghijklmnopqrstuvwx1234' }, 'DF-021');
check('AFF 拉新无内容', { signals: S({ aff_link: true }) }, 'DF-010');
check('仅优惠码', { signals: S({ invite_code: true }), cleanText: '邀请码 ABCD1234' }, 'DF-011');
check('正文恰 10 字 → 不触发 DF-002', { cleanText: '一二三四五六七八九十', externalLinkCount: 3, signals: S({ external_link: true }) }, null);
check('低信息量闲聊', { cleanText: '哈哈哈这个真的好好玩啊，笑死我了，各位怎么看', externalLinkCount: 0 }, 'DF-020');

console.log('\n强制保留候选豁免 normal_only 规则（PRD 8.2）：\n');
check('AFF+强制保留 → 不过滤', { signals: S({ aff_link: true }), isMandatory: true }, null);
check('低信息量+强制保留 → 不过滤', { cleanText: '哈哈哈这个真的好好玩啊，笑死我了，各位怎么看', externalLinkCount: 0, isMandatory: true }, null);
check('密钥泄露+强制保留 → 仍过滤', { cleanText: 'sk-abcdefghijklmnopqrstuvwx1234', isMandatory: true }, 'DF-021');
check('已发送+强制保留 → 仍过滤', { alreadySentNoUpdate: true, isMandatory: true }, 'DF-001');

console.log('\n反向保护闸门（PRD 8.3 末段）：\n');
for (const [r, shouldThrow] of [['开源推广，无实质内容', true], ['star 数少', true],
                                ['羊毛帖', true], ['正文为空', false]] as const) {
  let threw = false;
  try { assertReasonAllowed(r as string); } catch { threw = true; }
  const ok = threw === shouldThrow;
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} 「${r}」 → ${threw ? '拒绝并转人工' : '允许'}`);
}
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
