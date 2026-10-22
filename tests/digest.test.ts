// 新版日报：确定性规则与渲染的回归测试
import assert from 'node:assert/strict';
import { classifyRepost, decodeEntities, extractRepos, isReplyOrTrivial, linksFor, preMergeByLinks, similarity, type DigestSourceItem, type DigestData } from '../packages/digest/src/core.ts';
import { renderDigestHtml, renderDigestText, renderDigestFeedHtml } from '../packages/digest/src/render.ts';
import { checkEmail } from '../packages/templates/src/email.ts';

const it = (o: Partial<DigestSourceItem>): DigestSourceItem => ({ id: 1, sourceId: 'x_openai', sourceName: '@OpenAI', vendor: 'openai', official: true,
  role: 'official', title: '', text: '', url: null, publishedAt: null, firstSeenAt: '2026-10-22T00:00:00Z', ...o });

assert.equal(decodeEntities('we&#39;re &amp; you'), "we're & you");
assert.ok(isReplyOrTrivial(it({ title: 'R to @foo: thanks', text: 'thanks' })));
assert.ok(isReplyOrTrivial(it({ title: 'lol', text: 'lol https://t.co/x' })));
assert.ok(!isReplyOrTrivial(it({ title: 'Introducing GPT-6', text: 'Introducing GPT-6, our most capable model with new reasoning features.' })));
assert.ok(!isReplyOrTrivial(it({ sourceId: 'openai_news', title: 'Short', text: 'x' })), '官网条目不按长度过滤');

assert.deepEqual(extractRepos('see https://github.com/Foo/Bar.git and github.com/features/copilot, github.com/a-b/c_d.'), ['foo/bar', 'a-b/c_d']);
assert.ok(similarity('OpenAI 发布 GPT-6 模型', 'OpenAI 发布了 GPT-6 模型') > 0.6);
assert.ok(similarity('Cloudflare outage', 'Gemma 4 release') < 0.2);

const off = it({ id: 10, title: 'Introducing Codex cloud', url: 'https://openai.com/index/codex-cloud/' });
assert.equal(classifyRepost(it({ id: 11, official: false, title: '转：OpenAI 新功能', text: '原文 https://openai.com/index/codex-cloud?utm_source=x' }), [off]).verdict, 'repost');
assert.equal(classifyRepost(it({ id: 12, official: false, title: '我写了个 Rust 小工具', text: 'github.com/me/tool' }), [off]).verdict, 'distinct');

const g = preMergeByLinks([off, it({ id: 20, title: 'Codex cloud is here', text: 'Read more https://openai.com/index/codex-cloud/' }), it({ id: 21, title: 'Other', text: 'nothing' })]);
assert.equal(g.length, 2);
assert.deepEqual(linksFor([off, it({ id: 30, sourceName: '@OpenAI', url: 'https://x.com/OpenAI/status/1' })]).map(l => l.label), ['@OpenAI', '@OpenAI (2)']);

const d: DigestData = { format: 'digest_v2', date: '2026-10-22', windowLabel: '午报', windowRange: '10-22 08:00–12:00',
  vendors: [{ vendor: 'openai', name: 'OpenAI', events: [{ title: 'Codex <cloud>', summary: '摘要。', itemIds: [1, 2],
    links: [{ label: 'OpenAI News', url: 'https://openai.com/a' }, { label: '@OpenAI', url: 'javascript:alert(1)' }] }] }],
  emptyVendors: ['Notion', 'DeepSeek'], projects: [{ repo: 'foo/bar', url: 'https://github.com/foo/bar', description: '一个工具', mentionedBy: [{ label: 'V2EX', url: 'https://v2ex.com/t/1' }] }],
  politics: '' };
const html = renderDigestHtml(d), text = renderDigestText(d), feed = renderDigestFeedHtml(d);
assert.deepEqual(checkEmail(html, text), []);
for (const s of [html, text, feed]) {
  assert.ok(s.includes('一、官方动态') && s.includes('二、开源项目') && s.includes('三、时政速览'));
  assert.ok(s.includes('Notion、DeepSeek：本期无更新'));
  assert.ok(!/[⭐★]/.test(s), '不得出现星标');
  assert.ok(!s.includes('Telegram'));
}
assert.ok(html.includes('北京时间 10-22 08:00–12:00'));
assert.ok(!html.includes('javascript:') && html.includes('&lt;cloud&gt;'));
console.log('digest: all passed');
