import { traceFacts } from '../packages/ai/src/fact-trace.ts';

let calls = 0;
const fakeFetch: typeof fetch = async (url) => {
  calls++;
  if (String(url).includes('bing.com')) return new Response(
    '<rss><channel><item><title>Apple confirms updates</title><link>https://www.apple.com/newsroom/2026/09/major-updates</link><description>Updates are now available.</description></item></channel></rss>',
    { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  return new Response('<html>official</html>', { status: 200 });
};

const result = await traceFacts('iOS 27 and macOS 27 updates are now available',
  'https://www.apple.com/newsroom/2026/09/major-updates-for-apples-software-platforms-are-now-available', fakeFetch,
  async url => ({ ok: true, url, addresses: ['1.1.1.1'] }));
if (result.origin?.reachable !== true || result.results.length !== 1 || calls !== 2)
  throw new Error(`fact trace failed: ${JSON.stringify(result)}`);
console.log('✅ 实时事实追溯：原文可访问且搜索结果可解析');
