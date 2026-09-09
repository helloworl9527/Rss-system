// SSRF 防护（PRD 4.4 / 19.2）
import { checkUrlSafe, isBlockedAddress } from '../packages/connectors/src/ssrf.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

console.log('IP 范围判定：\n');
{
  const blocked = ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.255',
                   '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1',
                   '::1', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1'];
  for (const ip of blocked) ok(`拒绝 ${ip}`, !!isBlockedAddress(ip), isBlockedAddress(ip) ?? '');
  const allowed = ['1.1.1.1', '8.8.8.8', '52.141.58.148', '172.32.0.1', '2001:4860:4860::8888'];
  for (const ip of allowed) ok(`放行 ${ip}`, isBlockedAddress(ip) === null);
}

console.log('\n云元数据服务（最危险的目标）：\n');
{
  const r = await checkUrlSafe('https://169.254.169.254/latest/meta-data/iam/security-credentials/');
  ok('AWS/Azure 元数据地址被拒', !r.ok, r.ok ? '' : r.reason);
}

console.log('\n协议与凭证：\n');
{
  for (const [u, why] of [
    ['http://example.com', 'http 明文'],
    ['file:///etc/passwd', 'file 协议'],
    ['gopher://evil.com', 'gopher 协议'],
    ['ftp://example.com', 'ftp 协议'],
    ['not a url', '格式非法'],
    ['https://user:pass@example.com', '内嵌凭证'],
  ] as const) {
    const r = await checkUrlSafe(u);
    ok(`拒绝 ${why}`, !r.ok, r.ok ? '' : r.reason);
  }
}

console.log('\n主机名黑名单：\n');
{
  for (const h of ['https://localhost/x', 'https://metadata.google.internal/x',
                   'https://foo.local/x', 'https://bar.internal/x']) {
    const r = await checkUrlSafe(h);
    ok(`拒绝 ${h.slice(8, 34)}`, !r.ok, r.ok ? '' : r.reason);
  }
}

console.log('\n直写内网 IP：\n');
{
  for (const u of ['https://127.0.0.1:3000/api/v1/dashboard',
                   'https://192.168.1.1/admin',
                   'https://[::1]:3000/']) {
    const r = await checkUrlSafe(u);
    ok(`拒绝 ${u.slice(8, 32)}`, !r.ok, r.ok ? '' : r.reason);
  }
}

console.log('\n正常来源应放行：\n');
{
  for (const u of ['https://linux.do/latest.rss',
                   'https://elsewhere.news/feed.xml',
                   'https://api-docs.deepseek.com/zh-cn/updates/']) {
    const r = await checkUrlSafe(u);
    ok(`放行 ${u.slice(8, 40)}`, r.ok, r.ok ? r.addresses.join(',') : r.reason);
  }
}

console.log('\nDNS 指向内网的域名（只看名字拦不住）：\n');
{
  // 公开的测试域名，A 记录固定指向 127.0.0.1
  const r = await checkUrlSafe('https://localtest.me/');
  ok('解析到 127.0.0.1 的域名被拒', !r.ok, r.ok ? '⚠️ 未拦下' : r.reason);
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
