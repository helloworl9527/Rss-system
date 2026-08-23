import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF 防护（PRD 4.4 / 19.2）。
 *
 * 后台的「测试抓取」让用户指定 URL 由服务器发起请求 —— 这是典型的
 * SSRF 攻击面：攻击者可用它探测内网、读取云厂商元数据服务
 * （169.254.169.254 上有实例凭证）、或访问只监听 127.0.0.1 的后台自身。
 *
 * 三层防护：
 *  1. 协议白名单：只允许 https（http 明文也拒绝）
 *  2. 主机名黑名单：localhost、.local、.internal 等
 *  3. DNS 解析后逐个 IP 校验 —— 这一层不可省：攻击者可以让
 *     evil.com 解析到 127.0.0.1，仅看主机名字符串完全拦不住。
 */

export type UrlCheck = { ok: true; url: string; addresses: string[] }
                    | { ok: false; reason: string };

const BLOCKED_HOSTNAMES = [
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata', 'metadata.google.internal', 'instance-data',
];
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa', '.onion'];

/** 判断一个 IP 是否属于必须拒绝的范围。 */
export function isBlockedAddress(ip: string): string | null {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    const [a, b] = [p[0]!, p[1]!];
    if (a === 0) return '「本网络」保留地址';
    if (a === 10) return '私有网段 10.0.0.0/8';
    if (a === 127) return '环回地址 127.0.0.0/8';
    if (a === 100 && b >= 64 && b <= 127) return '运营商级 NAT 100.64.0.0/10';
    if (a === 169 && b === 254) return '链路本地/云元数据 169.254.0.0/16';
    if (a === 172 && b >= 16 && b <= 31) return '私有网段 172.16.0.0/12';
    if (a === 192 && b === 168) return '私有网段 192.168.0.0/16';
    if (a === 192 && b === 0) return '保留网段 192.0.0.0/24';
    if (a >= 224) return '组播/保留地址';
    return null;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return 'IPv6 环回/未指定地址';
    if (s.startsWith('fe80')) return 'IPv6 链路本地';
    if (s.startsWith('fc') || s.startsWith('fd')) return 'IPv6 唯一本地地址';
    if (s.startsWith('ff')) return 'IPv6 组播';
    // IPv4 映射地址：::ffff:127.0.0.1 之类，必须解开再判
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isBlockedAddress(m[1]!);
    return null;
  }
  return '无法识别的 IP 格式';
}

/**
 * 校验 URL 是否可安全抓取。会真正做 DNS 解析。
 *
 * 注意：这里存在理论上的 TOCTOU（校验后 DNS 可能变化）。
 * 完全防御需要在建立连接时锁定 IP，代价较大；对本系统
 * （单用户、后台只监听本机、来源由所有者自己添加）这层足够。
 * 真正的定时抓取只走 sources.yaml 里已固化的端点，不受此影响。
 */
export async function checkUrlSafe(raw: string): Promise<UrlCheck> {
  let u: URL;
  try { u = new URL(String(raw).trim()); }
  catch { return { ok: false, reason: 'URL 格式非法' }; }

  if (u.protocol !== 'https:')
    return { ok: false, reason: `只允许 https，实际为 ${u.protocol.replace(':', '') || '（空）'}` };
  if (u.username || u.password)
    return { ok: false, reason: 'URL 不得内嵌用户名或口令' };

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.includes(host))
    return { ok: false, reason: `主机名 ${host} 在黑名单中` };
  if (BLOCKED_SUFFIXES.some(sfx => host.endsWith(sfx)))
    return { ok: false, reason: `主机名后缀不允许（${host}）` };

  // 直接写 IP 的情况
  if (isIP(host)) {
    const bad = isBlockedAddress(host);
    if (bad) return { ok: false, reason: `目标地址不允许：${bad}` };
    return { ok: true, url: u.toString(), addresses: [host] };
  }

  // 域名：必须解析后逐个 IP 校验 —— 只看名字拦不住 DNS 指向内网
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch (e: any) {
    return { ok: false, reason: `DNS 解析失败：${String(e?.code ?? e?.message ?? e)}` };
  }
  if (!addrs.length) return { ok: false, reason: 'DNS 未返回任何地址' };

  for (const a of addrs) {
    const bad = isBlockedAddress(a.address);
    if (bad) return { ok: false, reason: `${host} 解析到 ${a.address}（${bad}）` };
  }
  return { ok: true, url: u.toString(), addresses: addrs.map(a => a.address) };
}
