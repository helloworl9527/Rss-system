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

const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

console.log('\n公益站/中转站运营与争议（DF-040 / DF-041，来自人工反馈）：\n');
{
  // 用户明确指出这三类应过滤，且给了边界：第三方转售站的自设规则
  // 不是 PRD 8.2 C 类保护的「官方权益」。
  const fire = (text: string) => {
    const r = applyDeterministicFilters({ ...base, cleanText: text, title: text });
    return r?.ruleId ?? null;
  };
  ok('公益站内测招募 → DF-040',
     fire('【首家视频公益站】Seedance 图生视频公益站 主贴 第二波内测开放限时测试') === 'DF-040');
  // 规则要求同时出现「站点类关键词」与「运营动作词」—— 缺任一都不触发，
  // 这是刻意的：只说「计价调整」的正常价格新闻不该被误伤。
  ok('中转站计价调整通知 → DF-040',
     fire('【RelayFor】中转站通知一览：上游计价调整与错误补偿方案') === 'DF-040');
  ok('只有计价调整、无站点词 → 不触发',
     fire('OpenAI 宣布上游计价调整与错误补偿方案') === null);
  ok('站点争议爆料 → DF-040/041',
     ['DF-040', 'DF-041'].includes(fire('【恶臭曝光】KRILL 中转站客服滥用权限全群开盒订单隐私') ?? ''));

  // 不得误伤：真实技术内容、官方政策、正常付费教程
  for (const t of [
    'Qwen3.8 27B 单16G显存显卡本地测试与部署教程，含 128K 上下文配置',
    'Tibo 明确发帖称 Codex 订阅不支持通过 sub2api 转换并转售',
    'claude 用 google pay 订阅 pro，招行 visa 全币种实测可行',
    'cursor 生成邮件的 JS 脚本，完全根据 QQ 邮箱来改，附完整代码',
  ]) ok(`不误伤：${t.slice(0, 22)}…`, fire(t) === null, fire(t) ?? '');

  // 有服务商官方链接时不适用 DF-040 —— 那可能是真的官方权益变更
  const withOfficial = applyDeterministicFilters({
    ...base, title: '某中转站公告：上游计价调整',
    cleanText: '某中转站公告：上游计价调整，详见 https://openai.com/pricing',
    signals: S({ official_link: true }) });
  ok('带官方链接的计价公告不被 DF-040 过滤', withOfficial?.ruleId !== 'DF-040', withOfficial?.ruleId ?? '不过滤');
}

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
