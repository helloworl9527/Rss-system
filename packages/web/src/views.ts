/**
 * 服务端渲染的后台页面（PRD 16）。
 *
 * 单用户后台不需要 SPA —— 服务端渲染省掉构建链、省内存，
 * 且 CSP 可以完全禁掉脚本（default-src 'none'），攻击面最小。
 * 所有动态值一律转义：数据库里存的是来源方提供的不可信文本。
 */

import type { Alert, BackupStatus, DiskStatus, UnitStatus } from './ops.ts';

export const esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ago = (t: unknown): string => {
  if (!t) return '—';
  const m = Math.round((Date.now() - Date.parse(String(t))) / 60000);
  if (!Number.isFinite(m)) return '—';
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 1440)} 天前`;
};

const CSS = `
/* 侧栏 + 主内容。系统字体：后台 CSP 为 default-src 'none'，不加载任何外部字体。 */
:root{
  color-scheme:light;
  --page:#f4f6f9; --card:#fff; --line:#dde3eb; --line-soft:#edf1f5;
  --ink:#141a23; --body:#3a4452; --muted:#687384; --faint:#8a95a5;
  --accent:#1f5aa6; --accent-soft:#e6eef9;
  --ok:#137a4b; --ok-soft:#e3f3ea; --warn:#9a5b06; --warn-soft:#fbf0de; --bad:#b4271f; --bad-soft:#fbe7e5;
  --side:#eef2f7; --side-ink:#2b3442; --side-on:#fff;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
@media(prefers-color-scheme:dark){:root{
  color-scheme:dark;
  --page:#11151b; --card:#181d25; --line:#2a323d; --line-soft:#212832;
  --ink:#e9eef5; --body:#c3ccd7; --muted:#8a95a5; --faint:#6b7684;
  --accent:#86b3ee; --accent-soft:#1b2a40;
  --ok:#55c995; --ok-soft:#15302a; --warn:#e3a849; --warn-soft:#352812; --bad:#f2827a; --bad-soft:#3a1d1c;
  --side:#141920; --side-ink:#c3ccd7; --side-on:#202733;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--body);
  font:14.5px/1.65 -apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased}
.shell{display:grid;grid-template-columns:200px minmax(0,1fr);min-height:100vh}
.side{background:var(--side);border-right:1px solid var(--line);padding:18px 12px;display:flex;flex-direction:column;gap:2px;
  position:sticky;top:0;height:100vh;overflow-y:auto}
.side .brand{font-weight:700;color:var(--ink);font-size:15px;padding:2px 10px 16px}
.side a{display:flex;justify-content:space-between;align-items:center;gap:8px;color:var(--side-ink);text-decoration:none;
  padding:7px 10px;border-radius:7px;font-size:14px}
.side a:hover{background:var(--side-on)}
.side a.on{background:var(--side-on);color:var(--ink);font-weight:600;box-shadow:0 0 0 1px var(--line)}
.side .grp{font-size:11px;letter-spacing:.1em;color:var(--muted);padding:16px 10px 4px}
.side form{margin-top:auto;padding:12px 10px 0}
.side form button{width:100%}
.cnt{font-size:11px;font-variant-numeric:tabular-nums;border-radius:9px;padding:0 7px;font-weight:600;line-height:18px}
.cnt.bad{background:var(--bad-soft);color:var(--bad)} .cnt.warn{background:var(--warn-soft);color:var(--warn)}

main{max-width:1180px;width:100%;padding:24px 28px 64px;display:block}
.page-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 18px}
.page-h h1{font-size:20px;color:var(--ink);margin:0;text-wrap:balance}
.page-h span{font-size:12.5px;color:var(--muted)}
h2{font-size:15px;color:var(--ink);font-weight:650;margin:30px 0 10px}
h2:first-child{margin-top:0}
.sub{font-size:13px;color:var(--muted);margin:-4px 0 12px}
.stack{display:grid;gap:10px}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:0 0 16px;flex-wrap:wrap}
.tabs a{padding:7px 13px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px;font-size:14px}
.tabs a:hover{color:var(--ink)}
.tabs a.on{color:var(--ink);border-color:var(--accent);font-weight:600}
.pill.idle{background:var(--line-soft);color:var(--muted)}

.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:0 0 6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:13px 15px;display:grid;gap:3px;align-content:start}
.card .n{font-size:21px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums;line-height:1.3}
.card .l{font-size:12px;color:var(--muted)}
.card .d{font-size:12px;color:var(--muted);line-height:1.5}
.bar{height:5px;border-radius:3px;background:var(--line-soft);overflow:hidden;margin:2px 0}
.bar i{display:block;height:100%;background:var(--accent)} .bar i.warn{background:var(--warn)} .bar i.bad{background:var(--bad)}

.alerts{display:grid;gap:8px}
.alert{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 14px;border-radius:8px;
  border:1px solid var(--line);background:var(--card)}
.alert.bad{border-color:color-mix(in srgb,var(--bad) 35%,var(--line));background:var(--bad-soft)}
.alert.warn{border-color:color-mix(in srgb,var(--warn) 35%,var(--line));background:var(--warn-soft)}
.alert .sev{font-size:11px;font-weight:700;letter-spacing:.06em}
.alert.bad .sev{color:var(--bad)} .alert.warn .sev{color:var(--warn)} .alert.ok .sev{color:var(--ok)}
.alert .t{color:var(--ink);font-size:13.5px} .alert .t small{display:block;color:var(--muted);font-size:12.5px}
.alert a.act{font-size:12.5px;white-space:nowrap}

.day{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.slot{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:12px 14px;display:grid;gap:6px;align-content:start}
.slot .h{display:flex;justify-content:space-between;align-items:baseline}
.slot .h b{font-size:15px;color:var(--ink)} .slot .h span{font-family:var(--mono);font-size:12px;color:var(--muted)}
.slot .s{font-size:12.5px;color:var(--muted);line-height:1.55}

table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden}
th{font-weight:600;font-size:11.5px;color:var(--muted);padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 12px;font-size:13.5px;border-bottom:1px solid var(--line-soft);vertical-align:top;color:var(--body)}
tr:last-child td{border-bottom:none}
td b{color:var(--ink);font-weight:600}
td small{display:block;color:var(--muted);font-size:12px}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
td a{color:var(--accent);text-decoration:none} td a:hover{text-decoration:underline}
.tw{overflow-x:auto}

.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.muted{color:var(--muted);font-size:12.5px;line-height:1.55}
.pill{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:10px;font-size:11.5px;font-weight:600;
  background:var(--line-soft);color:var(--muted);white-space:nowrap}
.pill.accent{background:var(--accent-soft);color:var(--accent)}
.pill.ok,.pill.warn,.pill.bad,.pill.idle{gap:5px}
.pill.ok::before,.pill.warn::before,.pill.bad::before,.pill.idle::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.ok{background:var(--ok-soft);color:var(--ok)} .pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.bad{background:var(--bad-soft);color:var(--bad)}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px}
code,.mono{font-family:var(--mono);font-size:12.5px}
.feed{font-family:var(--mono);font-size:12px;width:100%}

button{font:inherit;font-size:13px;padding:5px 13px;border:1px solid var(--line);
  background:var(--card);color:var(--ink);border-radius:7px;cursor:pointer;transition:border-color .12s}
button:hover{border-color:var(--muted)}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--card);font-weight:600}
button.primary:hover{opacity:.9}
input,select,textarea{font:inherit;font-size:13px;padding:5px 9px;border:1px solid var(--line);
  border-radius:7px;background:var(--card);color:var(--ink)}
input::placeholder{color:var(--faint)}
form.inline{display:flex;gap:6px;align-items:center;margin:0;flex-wrap:wrap}
form.inline input[name=reason]{width:158px}
details{background:var(--card);border:1px solid var(--line);border-radius:9px;margin:10px 0;overflow:hidden}
summary{cursor:pointer;padding:10px 14px;font-weight:600;color:var(--ink)}
details>table{border-width:1px 0 0;border-radius:0}
details.vendor{margin:8px 12px 12px}

form.login{max-width:352px;margin:11vh auto;background:var(--card);border:1px solid var(--line);
  border-radius:12px;padding:30px 28px}
form.login h2{font-size:19px;color:var(--ink);margin:0 0 4px}
form.login .hint{font-size:13px;color:var(--muted);margin:0 0 20px}
form.login label{display:block;font-size:12px;color:var(--muted);margin:14px 0 5px;font-weight:500}
form.login input{width:100%;padding:10px 12px;font-size:14px}
form.login button{width:100%;padding:10px;margin-top:22px;font-size:14px}

.err,.note{padding:10px 14px;border-radius:8px;font-size:13.5px;line-height:1.6;margin:0 0 16px}
.err{background:var(--bad-soft);border:1px solid color-mix(in srgb,var(--bad) 32%,var(--line));color:var(--bad)}
.note{background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 24%,var(--line));color:var(--body)}
a{color:var(--accent)}
@media(max-width:860px){
  .shell{grid-template-columns:1fr}
  .side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;gap:4px;padding:10px 12px;border-right:none;border-bottom:1px solid var(--line)}
  .side .brand{width:100%;padding:2px 6px 6px}
  .side .grp{display:none}
  .side form{margin:0 0 0 auto;padding:0}
  main{padding:18px 16px 40px}
  .day{grid-template-columns:1fr}
  .alert{grid-template-columns:1fr}
  th,td{padding:8px 9px;font-size:13px}
}`;

export type NavKey = 'today' | 'runs' | 'sources' | 'telegram' | 'feeds' | 'system' | 'settings';
export type NavBadges = Partial<Record<NavKey, { count: number; level: 'bad' | 'warn' }>>;
let navBadges: () => NavBadges = () => ({});
/** 服务端启动时注册：侧栏每个页面旁显示待处理数量。计算失败不影响页面渲染。 */
export function setNavBadges(fn: () => NavBadges): void { navBadges = fn; }

const NAV: Array<[NavKey, string, string] | string> = [
  ['today', '/', '今日'], ['runs', '/runs', '日报记录'], ['sources', '/sources', '来源'], ['telegram', '/telegram', 'Telegram'], ['feeds', '/feeds', '订阅输出'],
  '系统', ['system', '/system', '系统运行'], ['settings', '/settings', '设置'],
];
const NAV_BY_TITLE: Record<string, NavKey> = { '今日': 'today', '仪表盘': 'today', '日报记录': 'runs', '来源': 'sources', '全网热点': 'sources',
  'Telegram 订阅': 'telegram', 'Telegram': 'telegram', '订阅输出': 'feeds', '系统运行': 'system', '设置': 'settings' };

export function layout(title: string, body: string, csrf: string, active: NavKey | undefined = NAV_BY_TITLE[title]): string {
  let badges: NavBadges = {};
  try { badges = navBadges(); } catch { /* 侧栏计数失败不影响页面 */ }
  const links = NAV.map(item => {
    if (typeof item === 'string') return `<div class="grp">${esc(item)}</div>`;
    const [key, href, label] = item; const b = badges[key];
    return `<a href="${href}"${key === active ? ' class="on" aria-current="page"' : ''}>${esc(label)}${b && b.count ? `<span class="cnt ${b.level}">${b.count}</span>` : ''}</a>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 十六源日报后台</title><style>${CSS}</style></head><body>
<div class="shell"><nav class="side" aria-label="主导航"><span class="brand">十六源日报</span>${links}
  <form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>登出</button></form>
</nav><main>${body}</main></div></body></html>`;
}

export function renderLogin(o: { configured: boolean; needTotp: boolean; error?: string }): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 十六源简报后台</title><style>${CSS}</style></head><body>
<form class="login" method="post" action="/login">
  <h2>十六源简报</h2>
  <div class="hint">管理后台</div>
  ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
  ${o.configured ? '' : '<div class="note">尚未设置 ADMIN_PASSWORD_HASH，当前为只读演示模式，无法登录。</div>'}
  <label>口令</label>
  <input type="password" name="password" autocomplete="current-password" required>
  ${o.needTotp ? '<label>动态验证码</label><input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required>' : ''}
  <button type="submit" class="primary">登录</button>
</form></body></html>`;
}

const healthCls = (h: string) => h === 'healthy' ? 'ok' : h === 'degraded' ? 'warn' : h === 'failing' ? 'bad' : 'muted';
const healthTxt = (h: string) => ({ healthy: '正常', degraded: '降级', failing: '失败' }[h] ?? '未知');
/** 状态用圆点+文字双重编码，不靠颜色单独表达含义。 */
const healthDot = (h: string) =>
  `<span class="${healthCls(h)}"><span class="dot" style="background:currentColor"></span>${healthTxt(h)}</span>`;

type Src = { id: string; display_name: string; category: string; health: string;
  source_group: string;
  allnet_json?: string | null;
  harvest_tier: string; consecutive_failures: number; last_success_at: string | null;
  last_http_code: number | null; last_error: string | null; latest_item_at: string | null; enabled: number;
  onboarding_status?: string; observation_until?: string | null;
  endpoint_url?: string | null; endpoint_parser?: string | null };

const PARSERS = [['rss','RSS / Atom'],['telegram_web','Telegram 网页版 (t.me/s/…)'],
                 ['v2ex_json','V2EX 官方热门 JSON'],
                 ['deepseek_page','DeepSeek 更新日志页'],
                 ['openai_release_notes_page','OpenAI 产品更新页（Jina）']];
const CATS = [['ai','AI 与科技'],['developer','开发者与产品'],['tech','技术资讯'],
              ['article','优质文章'],['society','社会与生活'],['forum','论坛']];
const TIERS = [['standard','标准 60 分钟'],['ranking_feed','榜单型 20 分钟'],
               ['official_changelog','官方日志 120 分钟'],['slow','低频 240 分钟']];
const SOURCE_GROUPS = [['unclassified','未归类'],['openai','OpenAI'],['claude','Claude'],
                       ['google','Google'],['deepseek','DeepSeek'],['cloudflare','Cloudflare'],
                       ['github','GitHub'],['hermes','Hermes Agent'],['meituan','美团'],
                       ['zhihu','知乎热搜'],['weibo','微博热搜'],['baidu','百度热搜']];
const opts = (list: string[][], cur = '') =>
  list.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');

export function renderSources(o: {
  csrf: string; sources: Array<Src & { managed_by?: string }>;
  tests?: Array<{ url: string; outcome: string; parsed_count: number | null; error: string | null; started_at: string }>;
  proposals?: any[];
  allnetCandidates?: Array<{id:number;title:string;existing?:string}>; allnetQuery?: string; baseUrl?:string;
  form?: Record<string, string>; saved?: string; error?: string;
}): string {
  const f = o.form ?? {};
  const admin = o.sources.filter(s => s.managed_by === 'admin');

  const allnetConfig = (s:Src) => `<a href="/allnet#${esc(s.id)}">管理全网热点采集与 RSS</a><div class="muted">此页开关仅控制参与日报，独立采集状态见全网热点页。</div>`;
  const manageRow = (s: Src & { managed_by?: string }) => `<tr>
    <td>${esc(s.display_name)}<div class="muted">${esc(s.id)}
      ${s.managed_by === 'admin' ? '<span class="pill accent">后台新增</span>' : ''}</div></td>
    <td style="min-width:300px">
      ${s.allnet_json ? allnetConfig(s) : s.endpoint_url ? `<form method="post" action="/sources/${esc(s.id)}/url">
        <input type="hidden" name="csrf" value="${esc(o.csrf)}">
        <input name="url" type="url" value="${esc(s.endpoint_url)}" required
          style="width:100%;min-width:280px" aria-label="${esc(s.display_name)}订阅 URL">
        <div class="inline" style="display:flex;gap:6px;margin-top:6px">
          <input name="reason" placeholder="修改理由（必填）" required minlength="4" style="flex:1">
          <button>测试并保存</button>
        </div>
        <div class="muted">解析器：${esc(s.endpoint_parser ?? '—')}</div>
      </form>` : '<span class="muted">无主订阅地址</span>'}
    </td>
    <td>${healthDot(s.health)}${s.enabled ? '' : `<span class="pill">${s.allnet_json?'未参与日报':'已停用'}</span>`}<div class="muted">${esc(ago(s.last_success_at))}</div>
      <form method="post" action="/sources/${esc(s.id)}/group" class="inline" style="margin-top:6px">
        <input type="hidden" name="csrf" value="${esc(o.csrf)}">
        <select name="source_group">${opts(SOURCE_GROUPS, s.source_group)}</select>
        <input name="reason" placeholder="调整理由（必填）" required minlength="4"><button>调整分组</button>
      </form></td>
    <td>
      <form method="post" action="/sources/${esc(s.id)}/toggle" class="inline">
        <input type="hidden" name="csrf" value="${esc(o.csrf)}">
        <input type="hidden" name="enabled" value="${s.enabled ? 'false' : 'true'}">
        <input type="hidden" name="redirect" value="/sources">
        <input name="reason" placeholder="理由（必填）" required minlength="4">
        <button>${s.allnet_json ? (s.enabled ? '停用参与日报' : '启用参与日报') : (s.enabled ? '停用' : '启用')}</button>
      </form>
      ${s.managed_by === 'admin' && !s.allnet_json ? `<form method="post" action="/sources/${esc(s.id)}/delete" class="inline" style="margin-top:5px">
        <input type="hidden" name="csrf" value="${esc(o.csrf)}">
        <input type="hidden" name="redirect" value="/sources">
        <input name="reason" placeholder="删除理由（必填）" required minlength="4">
        <button>删除</button></form>` : ''}
    </td></tr>`;
  const manageTable = (sources: Array<Src & { managed_by?: string }>) => sources.length
    ? `<table><tr><th>来源</th><th>订阅 URL</th><th>状态 / 分组</th><th>操作</th></tr>${sources.map(manageRow).join('')}</table>`
    : '<p class="muted" style="padding:0 14px 12px">暂无来源。</p>';
  const vendors = SOURCE_GROUPS.slice(1).filter(([key])=>!['zhihu','weibo','baidu'].includes(key!)).map(([key, label]) => {
    const rows = o.sources.filter(s => s.source_group === key);
    const bad = rows.filter(s => s.enabled && s.health !== 'healthy').length;
    return `<details class="vendor"><summary>${esc(label)}（${rows.length}${bad ? `，<span class="warn">${bad} 个异常</span>` : ''}）</summary>${manageTable(rows)}</details>`;
  }).join('');
  const vendorCount = o.sources.filter(s => !['unclassified','zhihu','weibo','baidu'].includes(s.source_group)).length;
  const unclassified = o.sources.filter(s => s.source_group === 'unclassified');
  const attention = o.sources.filter(s => s.enabled && (s.health === 'failing' || s.health === 'degraded'));
  const groupedSources = `${attention.length ? `<h2>需要关注 · ${attention.length} 个</h2><p class="sub">连续失败或降级的来源，展开下方分组可管理全部来源。</p>${manageTable(attention)}<h2>全部来源</h2>` : '<div class="alerts"><div class="alert ok"><span class="sev">正常</span><div class="t">所有启用的来源都在正常采集</div><span></span></div></div><h2>全部来源</h2>'}
    <details open><summary>科技厂商（${vendorCount}）</summary>${vendors}</details>
    <details open><summary>社会生活</summary>${SOURCE_GROUPS.filter(([key])=>['zhihu','weibo','baidu'].includes(key!)).map(([key,label])=>`<details open><summary>${esc(label)}</summary>${key==='baidu'?'<p class="muted">暂不可用 · 等待上游开放，无订阅地址</p>':''}${manageTable(o.sources.filter(s=>s.source_group===key))}</details>`).join('')}</details>
    <details open><summary>未归类（${unclassified.length}）</summary>${manageTable(unclassified)}</details>`;

  const testRows = (o.tests ?? []).map(t => `<tr>
    <td class="${t.outcome === 'ok' ? 'ok' : 'bad'}"><span class="dot" style="background:currentColor"></span>${esc(t.outcome)}</td>
    <td style="word-break:break-all">${esc(t.url.slice(0, 70))}</td>
    <td>${t.parsed_count ?? '—'}</td>
    <td class="muted">${esc(String(t.error ?? '').slice(0, 70))}</td>
    <td class="muted">${esc(ago(t.started_at))}</td></tr>`).join('');

  const body = `
  ${o.saved ? `<div class="note">${esc(o.saved)}</div>` : ''}
  ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
  <div class="page-h"><h1>来源</h1><span></span></div><nav class="tabs" aria-label="来源类型"><a href="/sources" class="on" aria-current="page">RSS 来源</a><a href="/allnet">全网热点</a></nav>
  <p class="sub">共 ${o.sources.length} 个来源，其中后台新增 ${admin.length} 个。分组仅用于后台整理，不改变日报筛选。</p>
  ${groupedSources}

  <h2>新增来源</h2>
  <p class="sub">系统会先做 SSRF/协议/体积检查并抓取样本，随后由独立 Source Profiler 生成画像与规则提案；人工批准前不会采集，也不会进入日报。</p>
  <form method="post" action="/sources/add">
    <input type="hidden" name="csrf" value="${esc(o.csrf)}">
    <table><tr><th>字段</th><th>值</th><th>说明</th></tr>
      <tr><td>ID</td><td><input name="id" value="${esc(f.id ?? '')}" placeholder="如 hacker_news" required style="width:200px"></td>
          <td class="muted">小写字母/数字/下划线，2–32 位，创建后不可改</td></tr>
      <tr><td>名称</td><td><input name="name" value="${esc(f.name ?? '')}" placeholder="如 Hacker News 首页" required style="width:260px"></td>
          <td class="muted">显示在简报与后台里</td></tr>
      <tr><td>URL</td><td><input name="url" value="${esc(f.url ?? '')}" placeholder="https://…" required style="width:100%;min-width:280px"></td>
          <td class="muted">RSS/Atom 地址或页面地址</td></tr>
      <tr><td>解析器</td><td><select name="parser">${opts(PARSERS, f.parser ?? 'rss')}</select></td>
          <td class="muted">多数订阅源选 RSS / Atom</td></tr>
      <tr><td>分类</td><td><select name="category">${opts(CATS, f.category ?? 'tech')}</select></td>
          <td class="muted">决定进简报的哪个分区</td></tr>
      <tr><td>来源分组</td><td><select name="source_group">${opts(SOURCE_GROUPS, f.source_group ?? 'unclassified')}</select></td>
          <td class="muted">用于后台归类展示，默认未归类</td></tr>
      <tr><td>采集频率</td><td><select name="tier">${opts(TIERS, f.tier ?? 'standard')}</select></td>
          <td class="muted">榜单型条目轮转快，需更密</td></tr>
      <tr><td>优先级</td><td><input name="priority" type="number" min="1" max="9" value="${esc(f.priority ?? '5')}" style="width:70px"></td>
          <td class="muted">1 最高，影响多来源同事件时选谁为主</td></tr>
      <tr><td>需抓全文</td><td><input type="checkbox" name="require_fulltext" ${f.require_fulltext ? 'checked' : ''}></td>
          <td class="muted">RSS 只给摘要时勾选，会额外打开原文</td></tr>
    </table>
    <p>
      <button class="primary">探测并生成提案</button>
    </p>
  </form>

  <h2>仅测试（不添加）</h2>
  <form method="post" action="/sources/test" class="inline" style="margin-bottom:6px">
    <input type="hidden" name="csrf" value="${esc(o.csrf)}">
    <input name="url" placeholder="https://…" required style="width:340px">
    <select name="parser">${opts(PARSERS, 'rss')}</select>
    <button>测试抓取</button>
  </form>

  ${testRows ? `<h2>最近测试记录</h2>
    <table><tr><th>结果</th><th>URL</th><th>条数</th><th>错误</th><th>时间</th></tr>${testRows}</table>` : ''}

  ${o.proposals?.length ? `<h2>来源画像与审批提案</h2><table><tr><th># / 来源</th><th>状态</th><th>画像摘要</th><th>证据与模型</th><th>操作</th></tr>${o.proposals.map((p: any) => {
    const prof = (() => { try { return JSON.parse(p.source_profile_json ?? '{}'); } catch { return {}; } })();
    const action = ['HUMAN_REVIEW','AI_ANALYZED'].includes(p.status) ? `<form method="post" action="/sources/proposals/${esc(p.id)}/approve" class="inline"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button class="primary">批准并观察</button></form><form method="post" action="/sources/proposals/${esc(p.id)}/reject" class="inline"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input name="reason" required minlength="4" placeholder="拒绝理由"><button>拒绝</button></form>` : '';
    return `<tr><td>#${esc(p.id)}<div class="muted">${esc(p.source_name)}<br>${esc(p.source_url)}</div></td><td>${esc(p.status)}${p.confidence != null ? ` <span class="pill">置信度 ${Math.round(Number(p.confidence)*100)}%</span>` : ''}</td><td>${esc([prof.source_type, prof.content_domain, prof.publisher_type, prof.officiality].filter(Boolean).join(' · ') || p.error || '待分析')}</td><td class="muted">样本 ${esc((JSON.parse(p.evidence_sample_ids || '[]') as any[]).length)} 条 · ${esc(p.model_profile_id ?? '—')} / v${esc(p.model_config_version ?? '—')}<br>规则 diff ${esc((JSON.parse(p.rule_diff_json || '[]') as any[]).length)} 条</td><td>${action}</td></tr>`;
  }).join('')}</table>` : ''}`;
  return layout('来源', body, o.csrf);
}

const PROVIDERS = [
  ['mock', 'mock（本地假响应，不花钱）'],
  ['deepseek', 'DeepSeek'],
  ['openai', 'OpenAI'],
  ['openai_compatible', 'OpenAI 兼容格式（自定义 Base URL）'],
  ['qwen', 'Qwen（DashScope 兼容模式）'],
  ['anthropic', 'Anthropic'],
  ['gemini', 'Gemini'],
];
const BASE_URL_DEFAULTS = [
  ['OpenAI', 'https://api.openai.com/v1'],
  ['DeepSeek', 'https://api.deepseek.com/v1'],
  ['Qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['Anthropic', 'https://api.anthropic.com'],
  ['Gemini', 'https://generativelanguage.googleapis.com/v1beta'],
];
const KEY_LABEL: Record<string, string> = {
  OPENAI_API_KEY: 'OpenAI', OPENAI_COMPAT_API_KEY: 'OpenAI 兼容格式', DEEPSEEK_API_KEY: 'DeepSeek', DASHSCOPE_API_KEY: 'Qwen / DashScope',
  ALLNET_API_KEY: '全网热点', ANTHROPIC_API_KEY: 'Anthropic', GEMINI_API_KEY: 'Gemini', SOURCE_PROFILER_API_KEY: 'Source Profiler 独立密钥',
  TELEGRAM_API_ID: 'Telegram API ID', TELEGRAM_API_HASH: 'Telegram API Hash', TELEGRAM_PHONE: 'Telegram 登录手机号',
};

export function renderSettings(o: {
  csrf: string;
  vaultOk: boolean; vaultReason?: string;
  secrets: Array<{ name: string; set: boolean; hint: string }>;
  settings: Record<string, string | undefined>;
  envOverrides: string[];
  /** Telegram 模块渲染的分组（总结、图片识别、数据保留），追加在页面末尾 */
  telegram?: string;
  saved?: string; error?: string;
}): string {
  const cur = o.settings.l1Provider ?? o.settings.aiProvider ?? 'mock';
  const providerOpts = (selected: string) => PROVIDERS.map(([v, label]) =>
    `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');

  const keyRows = o.secrets.map(k => `<tr>
    <td>${esc(KEY_LABEL[k.name] ?? k.name)}<div class="muted">${esc(k.name)}</div></td>
    <td>${k.set ? `<span class="ok">已设置</span> <span class="muted">${esc(k.hint)}</span>` : '<span class="muted">未设置</span>'}</td>
    <td><form method="post" action="/settings/secret" class="inline">
      <input type="hidden" name="csrf" value="${esc(o.csrf)}">
      <input type="hidden" name="name" value="${esc(k.name)}">
      <input type="password" name="value" placeholder="粘贴新 key（留空则清除）" autocomplete="off" style="width:230px">
      <button class="primary">保存</button>
    </form></td></tr>`).join('');

  const body = `
  ${o.saved ? `<div class="note">${esc(o.saved)}</div>` : ''}
  ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
  ${o.vaultOk ? '' : `<div class="err">密钥保管库不可用：${esc(o.vaultReason ?? '')}<br>
    需在 /etc/briefing/env 设置 APP_ENCRYPTION_KEY 并重启 brief-web。</div>`}
  ${o.envOverrides.length ? `<div class="note">以下项被环境变量覆盖，页面上的设置对它们无效：
    ${o.envOverrides.map(esc).join('、')}</div>` : ''}

  <div class="page-h"><h1>设置</h1><span>按模块分组</span></div>
  <nav class="tabs" aria-label="设置分组"><a href="#ai">日报 AI 模型</a><a href="#keys">API Key</a><a href="#profiler">来源画像</a><a href="#allnet">全网热点</a>${o.telegram ? '<a href="#telegram">Telegram 总结</a><a href="#vision">图片识别</a><a href="#retention">数据保留</a>' : ''}</nav>
  <h2 id="ai">日报 AI 模型与 API 地址</h2>
  <p class="sub">每个层级的 Base URL 都可以直接编辑。留空使用所选厂商的官方默认地址；“OpenAI 兼容格式”没有默认地址，必须填写 API 根地址（通常以 /v1 结尾）。</p>
  <form method="post" action="/settings/ai">
    <input type="hidden" name="csrf" value="${esc(o.csrf)}">
    <datalist id="base-url-defaults">${BASE_URL_DEFAULTS.map(([, url]) => `<option value="${esc(url)}">`).join('')}</datalist>
    <table><tr><th>层级</th><th>用途</th><th>供应商</th><th>模型 ID</th><th>Base URL（可直接编辑）</th></tr>
      <tr><td>L1</td><td class="muted">批量判定，单期约 80 条 —— 花钱大头</td>
        <td><select name="l1_provider">${providerOpts(cur)}</select></td>
        <td><input name="l1_model" value="${esc(o.settings.l1Model ?? '')}" placeholder="模型 ID" style="width:180px"></td>
        <td><input name="l1_base_url" list="base-url-defaults" value="${esc(o.settings.l1BaseUrl ?? '')}" placeholder="留空 = 厂商默认地址" style="width:300px"></td></tr>
      <tr><td>L2</td><td class="muted">复核，单期最多 5 条</td>
        <td><select name="l2_provider"><option value="">同 L1</option>${providerOpts(o.settings.l2Provider ?? '')}</select></td>
        <td><input name="l2_model" value="${esc(o.settings.l2Model ?? '')}" placeholder="留空则同 L1" style="width:180px"></td>
        <td><input name="l2_base_url" list="base-url-defaults" value="${esc(o.settings.l2BaseUrl ?? '')}" placeholder="留空 = 厂商默认地址" style="width:300px"></td></tr>
      <tr><td>L3</td><td class="muted">高风险，单期最多 2 条</td>
        <td><select name="l3_provider"><option value="">同 L1</option>${providerOpts(o.settings.l3Provider ?? '')}</select></td>
        <td><input name="l3_model" value="${esc(o.settings.l3Model ?? '')}" placeholder="留空则同 L1" style="width:180px"></td>
        <td><input name="l3_base_url" list="base-url-defaults" value="${esc(o.settings.l3BaseUrl ?? '')}" placeholder="留空 = 厂商默认地址" style="width:300px"></td></tr>
    </table>
    <p class="muted">默认地址：${BASE_URL_DEFAULTS.map(([name, url]) => `${esc(name)} = ${esc(url)}`).join(' ｜ ')}</p>
    <p><button class="primary" ${o.vaultOk ? '' : 'disabled'}>保存供应商设置</button></p>
  </form>

  <h2 id="keys">API Key</h2>
  <p class="muted">加密存于 /var/lib/briefing/secrets.enc（0600），主密钥在 root 控制的
    /etc/briefing/env 中。页面只显示末四位，任何情况下不回显明文。</p>
  <table><tr><th>厂商</th><th>状态</th><th>设置</th></tr>${keyRows}</table>

  <h2 id="profiler">来源画像 Source Profiler（独立于 L1/L2/L3）</h2>
  <p class="sub">用于新来源画像、样本证据和规则提案。保存后生成新的配置版本；连接/结构化输出测试通过后才可启用。</p>
  <form method="post" action="/settings/source-profiler">
    <input type="hidden" name="csrf" value="${esc(o.csrf)}">
    <table><tr><th>字段</th><th>值</th><th>说明</th></tr>
      <tr><td>供应商</td><td><select name="provider">${providerOpts(o.settings.sourceProfilerProvider ?? 'mock')}</select></td><td class="muted">选择 OpenAI 兼容格式时必须填写自定义 Base URL</td></tr>
      <tr><td>模型 ID</td><td><input name="model" value="${esc(o.settings.sourceProfilerModel ?? '')}" style="width:220px"></td><td class="muted">独立模型，不继承 L1</td></tr>
      <tr><td>Base URL</td><td><input name="base_url" list="base-url-defaults" value="${esc(o.settings.sourceProfilerBaseUrl ?? '')}" style="width:360px" placeholder="留空 = 厂商默认地址"></td><td class="muted">所有厂商均可覆盖；OpenAI 兼容格式必填</td></tr>
      <tr><td>凭据引用</td><td><input name="credential_ref" value="${esc(o.settings.sourceProfilerCredentialRef ?? 'SOURCE_PROFILER_API_KEY')}" style="width:220px"></td><td class="muted">密钥名，不显示密钥内容</td></tr>
      <tr><td>参数</td><td><input name="temperature" value="${esc(o.settings.sourceProfilerTemperature ?? '0.1')}" style="width:70px"> <input name="reasoning_effort" value="${esc(o.settings.sourceProfilerReasoningEffort ?? '')}" placeholder="reasoning effort" style="width:140px"></td><td></td></tr>
      <tr><td>限制</td><td><input name="max_input_chars" value="${esc(o.settings.sourceProfilerMaxInputChars ?? '24000')}" style="width:100px"> <input name="max_output_tokens" value="${esc(o.settings.sourceProfilerMaxOutputTokens ?? '1800')}" style="width:100px"> <input name="timeout_ms" value="${esc(o.settings.sourceProfilerTimeoutMs ?? '30000')}" style="width:100px"></td><td class="muted">输入字符 / 输出 token / 超时毫秒</td></tr>
      <tr><td>重试/回退</td><td><input name="retry_policy" value="${esc(o.settings.sourceProfilerRetryPolicy ?? '1')}" style="width:70px"> <input name="fallback_profile" value="${esc(o.settings.sourceProfilerFallbackProfile ?? '')}" placeholder="回退模型 profile" style="width:180px"></td><td></td></tr>
      <tr><td>启用</td><td><select name="enabled"><option value="true"${o.settings.sourceProfilerEnabled !== 'false' ? ' selected' : ''}>启用</option><option value="false"${o.settings.sourceProfilerEnabled === 'false' ? ' selected' : ''}>停用</option></select></td><td class="muted">启用前后台会执行结构化输出测试</td></tr>
    </table><p><button class="primary" ${o.vaultOk ? '' : 'disabled'}>测试并保存配置版本</button></p>
  </form>`;
  return layout('设置', body + `<h2 id="allnet">全网热点</h2><p>在上方密钥保管库保存或更新 ALLNET_API_KEY。订阅在“来源 → 全网热点”中按名称添加。</p><form method="post" action="/settings/allnet/test"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button>测试连通性</button></form>` + (o.telegram ?? ''), o.csrf, 'settings');
}

export function renderAllnet(o: {
  csrf:string; sources:Array<Src>; baseUrl?:string; saved?:string; error?:string;
  allnetCandidates?:Array<{id:number;title:string;existing?:string}>; allnetQuery?:string;
}):string {
  const rows=o.sources.filter(s=>s.allnet_json).map(s=>{
    const a=JSON.parse(s.allnet_json!);
    const active=!!s.enabled || !!a.collection_enabled;
    const url=a.token?`${o.baseUrl??''}/rss/allnet/${a.token}`:'';
    return `<tr id="${esc(s.id)}"><td>${esc(s.display_name)}<div class="muted">上游 ID ${a.upstream_id}</div></td>
      <td>${a.kind==='ranking'?'每轮前':'最新第一页，最多'} ${a.item_limit} 条<div>${a.kind==='ranking'?'20':'60'} 分钟</div></td>
      <td>全网热点：${a.collection_enabled?'已启用':'已停用'}<br>参与日报：${s.enabled?'已启用':'已停用'}
        <div>${active ? (!a.collection_enabled?'继续为日报采集':'正常采集') : '采集已停止，RSS 保留旧快照'}</div>
        <form method="post" action="/allnet/${esc(s.id)}/toggle"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="enabled" value="${a.collection_enabled?'false':'true'}"><button>${a.collection_enabled?'停用全网热点':'启用全网热点'}</button></form>
        <a href="/sources">前往来源页管理参与日报</a></td>
      <td>${healthDot(s.health)}<div>最近成功：${esc(a.snapshot_at??'尚无')}</div><div class="bad">${esc(s.last_error??'')}</div></td>
      <td>${url?`<label>RSS URL（选中复制）<input readonly value="${esc(url)}" style="width:100%"></label>`:'RSS 令牌已撤销'}
        <form method="post" action="/allnet/${esc(s.id)}/token"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button name="action" value="reset">重置令牌</button><button name="action" value="revoke">撤销令牌</button></form></td></tr>`;
  }).join('');
  return layout('全网热点', `
    <div class="page-h"><h1>来源</h1><span></span></div><nav class="tabs" aria-label="来源类型"><a href="/sources">RSS 来源</a><a href="/allnet" class="on" aria-current="page">全网热点</a></nav>
    <h2>全网热点订阅管理</h2>
    ${o.saved?`<div class="note">${esc(o.saved)}</div>`:''}${o.error?`<div class="err">${esc(o.error)}</div>`:''}
    <p>任一页面启用就继续采集；是否进入日报由来源页单独控制。新增订阅默认仅供 RSS。</p>
    <table><tr><th>来源</th><th>采集范围</th><th>启停状态</th><th>采集健康</th><th>RSS 与令牌</th></tr>${rows||'<tr><td colspan="5">暂无订阅</td></tr>'}</table>
    <p class="muted">百度热搜：暂不可用，等待上游开放。</p>
  <h2>按名称添加全网热点订阅</h2>
  <form method="post" action="/allnet/search"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input name="name" required maxlength="100" placeholder="网站已有的来源名称"><input name="origin" type="url" placeholder="原站 HTTPS 地址（仅相对链接需要）"><button>搜索并订阅</button></form>
  <p class="sub">唯一精确匹配时测试后直接订阅；多个候选请选择。无需 AI 画像审批。新增后请到来源页单独启用参与日报。</p>
  ${(o.allnetCandidates??[]).map(c=>`<form method="post" action="/allnet/add"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="name" value="${esc(o.allnetQuery??'')}"><input type="hidden" name="upstream_id" value="${c.id}"><span>${esc(c.title)}</span><input name="origin" type="url" placeholder="原站地址（如需要）"> ${c.existing?`<span>已订阅：${esc(c.existing)}</span>`:'<button>测试并订阅</button>'}</form>`).join('')}

  `,o.csrf);
}

// ---------------- 今日 / 系统运行（后台改版第一期） ----------------

const fmtTime = (ms: number | null | undefined, withDate = false): string => ms == null || !Number.isFinite(ms) ? '—'
  : new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit',
      ...(withDate ? { month: '2-digit', day: '2-digit' } : {}) });
const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分` : s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
};
const until = (ms: number, now: number): string => {
  const m = Math.round((ms - now) / 60000);
  return m < 60 ? `${m} 分钟后` : m < 1440 ? `${Math.round(m / 60)} 小时后` : `${Math.round(m / 1440)} 天后`;
};
const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;
const mb = (b: number) => b >= 2 ** 30 ? gb(b) : `${Math.round(b / 2 ** 20)} MB`;
const num = (n: number) => Number(n ?? 0).toLocaleString('en-US');


export type TodaySlot = { key: string; label: string; clock: string; scheduledAt: number;
  run?: { id?: number; status: string; error: string | null; started_at: string | null; finished_at: string | null } | null;
  items?: number | null; delivery?: { status: string; sent_at: string | null; error: string | null } | null };

function slotCard(s: TodaySlot, now: number): string {
  const r = s.run;
  let pill: string, detail: string;
  if (!r) {
    if (s.scheduledAt > now) { pill = '<span class="pill idle">未开始</span>'; detail = `${until(s.scheduledAt, now)}开始`; }
    else if (now - s.scheduledAt < 15 * 60_000) { pill = '<span class="pill idle">等待启动</span>'; detail = '定时任务即将开始'; }
    else { pill = '<span class="pill bad">没有运行</span>'; detail = '到点后没有找到运行记录，请检查系统运行页'; }
  } else if (r.status === 'succeeded') {
    const sent = s.delivery?.status === 'sent';
    pill = sent ? '<span class="pill ok">已投递</span>' : `<span class="pill warn">${esc(s.delivery?.status ?? '未投递')}</span>`;
    const took = r.started_at && r.finished_at ? `用时 ${fmtDur(Date.parse(r.finished_at) - Date.parse(r.started_at))}` : '';
    detail = [took, s.items != null ? `${s.items} 条` : '', sent ? `${fmtTime(Date.parse(s.delivery!.sent_at!))} 送达` : esc(s.delivery?.error ?? '')]
      .filter(Boolean).join(' · ');
  } else if (r.status === 'partial' || r.status === 'failed') {
    pill = '<span class="pill bad">未发送</span>'; detail = esc((r.error ?? '运行未成功').slice(0, 120));
  } else {
    pill = '<span class="pill warn">进行中</span>';
    detail = r.started_at ? `已运行 ${fmtDur(now - Date.parse(r.started_at))}` : esc(r.status);
  }
  return `<div class="slot"><div class="h"><b>${r?.id ? `<a href="/runs/${r.id}">${esc(s.label)}</a>` : esc(s.label)}</b><span>${esc(s.clock)}</span></div>${pill}<div class="s">${detail}</div></div>`;
}

export function renderToday(o: {
  csrf: string; now: number; dateLabel: string; alerts: Alert[]; slots: TodaySlot[];
  rss: { healthy: number; enabled: number; lastHarvestAt: string | null; lastHarvestNew: number | null };
  telegram: { active: number; enabled: number; messages24h: number; authorized: boolean };
  ai: { calls: number };
  disk: DiskStatus;
}): string {
  const alerts = o.alerts.length
    ? `<div class="alerts">${o.alerts.map(a => `<div class="alert ${a.level}"><span class="sev">${a.level === 'bad' ? '故障' : '留意'}</span>
        <div class="t">${esc(a.title)}<small>${esc(a.detail)}</small></div><a class="act" href="${esc(a.href)}">查看</a></div>`).join('')}</div>`
    : '<div class="alerts"><div class="alert ok"><span class="sev">正常</span><div class="t">没有需要处理的事项</div><span></span></div></div>';
  const pct = o.disk ? o.disk.usedBytes / o.disk.totalBytes : 0;
  const body = `
  <div class="page-h"><h1>今日 · ${esc(o.dateLabel)}</h1><span>台北时间 ${fmtTime(o.now)} 更新</span></div>
  <h2>待处理</h2>${alerts}
  <h2>今天的日报</h2><div class="day">${o.slots.map(s => slotCard(s, o.now)).join('')}</div>
  <h2>运行概况</h2>
  <div class="cards">
    <div class="card"><span class="l">RSS 来源</span><span class="n">${o.rss.healthy} / ${o.rss.enabled}</span>
      <span class="d">${o.rss.enabled - o.rss.healthy ? `${o.rss.enabled - o.rss.healthy} 个降级或失败` : '全部正常'} · 最近采集 ${esc(ago(o.rss.lastHarvestAt))}${o.rss.lastHarvestNew != null ? `，新增 ${o.rss.lastHarvestNew} 条` : ''}</span></div>
    <div class="card"><span class="l">Telegram</span><span class="n">${o.telegram.active} / ${o.telegram.enabled}</span>
      <span class="d">${o.telegram.authorized ? '账号已登录' : '<span class="bad">账号未登录</span>'} · 24 小时消息 ${num(o.telegram.messages24h)}</span></div>
    <div class="card"><span class="l">AI 判定（今天）</span><span class="n">${num(o.ai.calls)} 次</span>
      <span class="d">日报候选的初筛、复核与组装</span></div>
    <div class="card"><span class="l">磁盘</span><span class="n">${o.disk ? `${Math.round(pct * 100)}%` : '—'}</span>
      ${o.disk ? `<div class="bar"><i class="${pct >= .95 ? 'bad' : pct >= .85 ? 'warn' : ''}" style="width:${Math.round(pct * 100)}%"></i></div><span class="d">剩余 ${gb(o.disk.freeBytes)}</span>` : '<span class="d">无法读取</span>'}</div>
  </div>
  <p class="sub" style="margin-top:18px">日报、Telegram 汇总等所有 RSS 地址在 <a href="/feeds">订阅输出</a> 页。</p>`;
  return layout('今日', body, o.csrf, 'today');
}

const STAGE_LABEL: Record<string, string> = { luna: 'L1 初筛', terra: 'L2 复核', sol: 'L3 复核', compose: '简报组装' };

export function renderSystem(o: { csrf: string; now: number; units: UnitStatus[]; backups: BackupStatus[]; disk: DiskStatus;
  ai24h: { calls: number; byStage: Array<{ stage: string; model: string; calls: number }> } }): string {
  const unitRow = (u: UnitStatus) => {
    const running = u.active === 'activating' || (u.kind === 'daemon' && u.active === 'active');
    const pill = u.kind === 'daemon'
      ? (u.active === 'active' ? '<span class="pill ok">运行中</span>' : `<span class="pill bad">${esc(u.active)}</span>`)
      : running ? '<span class="pill warn">正在运行</span>'
      : u.result === 'success' ? '<span class="pill ok">成功</span>'
      : u.result === 'unknown' ? '<span class="pill idle">未知</span>' : `<span class="pill bad">${esc(u.result)}</span>`;
    const last = u.kind === 'daemon' ? (u.startedAt ? `${fmtTime(u.startedAt, true)} 启动` : '—')
      : u.startedAt ? `${fmtTime(u.startedAt, true)}${u.exitedAt && u.exitedAt >= u.startedAt ? ` · ${fmtDur(u.exitedAt - u.startedAt)}` : ''}` : '—';
    const next = u.kind === 'daemon' ? '常驻' : u.nextAt ? `${fmtTime(u.nextAt, u.nextAt - o.now > 20 * 3600_000)}（${until(u.nextAt, o.now)}）` : esc(u.every ?? '—');
    return `<tr><td><b>${esc(u.label)}</b><small>${esc(u.id)}</small></td><td>${pill}</td><td>${last}</td><td>${next}</td></tr>`;
  };
  const pct = o.disk ? o.disk.usedBytes / o.disk.totalBytes : 0;
  const body = `
  <div class="page-h"><h1>系统运行</h1><span>定时任务状态读取自 systemd · ${fmtTime(o.now)} 更新</span></div>
  <h2>定时任务</h2>
  ${o.units.length ? `<div class="tw"><table><tr><th>任务</th><th>上次结果</th><th>上次运行</th><th>下次运行</th></tr>${o.units.map(unitRow).join('')}</table></div>`
    : '<div class="err">无法读取 systemd 状态，请在服务器上执行 systemctl status brief-* 查看。</div>'}
  <h2>备份与存储</h2>
  <div class="cards">
    ${o.backups.map(b => `<div class="card"><span class="l">${esc(b.label)}备份</span><span class="n">${b.file ? mb(b.bytes) : '—'}</span>
      <span class="d">${b.mtime ? `${fmtTime(b.mtime, true)} · 只保留最新 1 份` : '<span class="bad">没有找到备份</span>'}</span></div>`).join('')}
    <div class="card"><span class="l">磁盘</span><span class="n">${o.disk ? `${gb(o.disk.usedBytes)} / ${gb(o.disk.totalBytes)}` : '—'}</span>
      ${o.disk ? `<div class="bar"><i class="${pct >= .95 ? 'bad' : pct >= .85 ? 'warn' : ''}" style="width:${Math.round(pct * 100)}%"></i></div><span class="d">剩余 ${gb(o.disk.freeBytes)}</span>` : ''}</div>
  </div>
  <h2>AI 判定（最近 24 小时）</h2>
  <p class="sub">日报候选共调用 ${num(o.ai24h.calls)} 次。Telegram 总结与图片识别的调用不在此表内。</p>
  ${o.ai24h.byStage.length ? `<div class="tw"><table><tr><th>环节</th><th>模型</th><th class="n">次数</th></tr>${o.ai24h.byStage.map(t =>
    `<tr><td>${esc(STAGE_LABEL[t.stage] ?? t.stage)}</td><td><code>${esc(t.model)}</code></td><td class="n">${num(t.calls)}</td></tr>`).join('')}</table></div>` : '<p class="muted">最近 24 小时没有调用。</p>'}`;
  return layout('系统运行', body, o.csrf, 'system');
}

// ---------------- 日报记录（后台改版第二期） ----------------

export type RunRow = { id: number; window_key: string; window_label: string; scheduled_at: string; started_at: string | null;
  finished_at: string | null; status: string; stage: string | null; trigger: string; error: string | null;
  cands: number; items: number | null; brief_id: number | null; delivery_status: string | null; sent_at: string | null; resends: number };

const runPill = (r: Pick<RunRow, 'status' | 'delivery_status'>, queued = false) =>
  queued ? '<span class="pill warn">排队中</span>'
  : r.status === 'succeeded' ? (r.delivery_status === 'sent' ? '<span class="pill ok">已投递</span>' : `<span class="pill warn">${esc(r.delivery_status ?? '未投递')}</span>`)
  : r.status === 'partial' || r.status === 'failed' ? '<span class="pill bad">未发送</span>'
  : '<span class="pill warn">进行中</span>';
const runTitle = (r: Pick<RunRow, 'window_key' | 'window_label'>) => `${r.window_key.slice(5, 10)} ${r.window_label}`;
const runDur = (r: Pick<RunRow, 'started_at' | 'finished_at'>) =>
  r.started_at && r.finished_at ? fmtDur(Date.parse(r.finished_at) - Date.parse(r.started_at)) : '—';

export function renderRuns(o: { csrf: string; runs: RunRow[]; filter: 'all' | 'failed'; queued: string[]; notice?: string }): string {
  const rows = o.runs.map(r => `<tr>
    <td><a href="/runs/${r.id}"><b>${esc(runTitle(r))}</b></a><small>${r.started_at ? `${fmtTime(Date.parse(r.started_at))} 开始` : '未开始'}</small></td>
    <td>${runPill(r, o.queued.includes(r.window_key))}</td>
    <td class="n">${num(r.cands)}</td><td class="n">${r.items ?? '—'}</td><td class="n">${runDur(r)}</td>
    <td>${r.status === 'succeeded' ? (r.sent_at ? `${fmtTime(Date.parse(r.sent_at), true)} 送达${r.resends ? ` · 补发 ${r.resends} 次` : ''}` : '') : `<span class="bad">${esc((r.error ?? '').slice(0, 80))}</span>`}</td>
    <td><a href="/runs/${r.id}">详情</a></td></tr>`).join('');
  const tab = (key: 'all' | 'failed', label: string) => `<a href="/runs${key === 'failed' ? '?status=failed' : ''}"${o.filter === key ? ' class="on" aria-current="page"' : ''}>${label}</a>`;
  const body = `
  ${o.notice ? `<div class="note">${esc(o.notice)}</div>` : ''}
  <div class="page-h"><h1>日报记录</h1><span>最近 ${o.runs.length} 次运行</span></div>
  <nav class="tabs" aria-label="筛选">${tab('all', '全部')}${tab('failed', '仅未发送')}</nav>
  <div class="tw"><table><tr><th>时段</th><th>状态</th><th class="n">候选</th><th class="n">入选</th><th class="n">用时</th><th>说明</th><th></th></tr>
  ${rows || '<tr><td colspan="7">没有符合条件的运行记录</td></tr>'}</table></div>`;
  return layout('日报记录', body, o.csrf, 'runs');
}

const DECISION: Record<string, [string, string]> = {
  retain: ['必选保留', 'ok'], normal: ['入选', 'ok'], escalate: ['待复核', 'warn'], filter: ['过滤', 'idle'] };
const STAGE: Record<string, string> = { luna: 'L1', terra: 'L2', sol: 'L3', compose: '组装' };

export function renderRunDetail(o: { csrf: string; run: RunRow; queued: boolean; notice?: string;
  deliveries: Array<{ delivery_type: string; resend_sequence: number; status: string; sent_at: string | null; created_at: string; error: string | null }>;
  candidates: Array<{ id: number; title: string; source_id: string; canonical_url: string | null; decision: string; mandatory_class: string | null;
    section: string | null; filter_reason: string | null; stage: string | null; confidence: number | null; ai_reason: string | null; overridden: number }> }): string {
  const r = o.run;
  const csrf = `<input type="hidden" name="csrf" value="${esc(o.csrf)}">`;
  const actions = [
    r.status !== 'succeeded' && r.finished_at ? `<form class="inline" method="post" action="/runs/${r.id}/rerun">${csrf}<button class="primary"${o.queued ? ' disabled' : ''}>${o.queued ? '已排队，等待运行' : '重新运行此时段'}</button></form>` : '',
    r.brief_id ? `<form class="inline" method="post" action="/runs/${r.id}/resend">${csrf}<button>重新发送邮件</button></form>` : '',
  ].filter(Boolean).join('');
  const groups = ['retain', 'normal', 'escalate', 'filter'].map(d => [d, o.candidates.filter(c => c.decision === d)] as const)
    .concat([['other', o.candidates.filter(c => !DECISION[c.decision])] as const]).filter(([, xs]) => xs.length);
  const cRow = (c: typeof o.candidates[number]) => {
    const [label, cls] = DECISION[c.decision] ?? [c.decision, 'idle'];
    return `<tr><td>${c.canonical_url ? `<a href="${esc(c.canonical_url)}" rel="noreferrer noopener" target="_blank">${esc(c.title)}</a>` : esc(c.title)}
      <small>${esc(c.source_id)}${c.section ? ` · ${esc(c.section)}` : ''}${c.mandatory_class && c.mandatory_class !== 'none' ? ` · ${esc(c.mandatory_class)} 类` : ''}${c.overridden ? ' · <b>已人工处理</b>' : ''}</small></td>
      <td><span class="pill ${cls}">${esc(label)}</span>${c.stage ? `<small>${esc(STAGE[c.stage] ?? c.stage)}${c.confidence != null ? ` · 置信 ${Math.round(c.confidence * 100)}%` : ''}</small>` : ''}</td>
      <td class="muted">${esc((c.filter_reason ?? c.ai_reason ?? '').slice(0, 140))}</td>
      <td><form class="inline" method="post" action="/candidates/${c.id}/override">${csrf}<input type="hidden" name="redirect" value="/runs/${r.id}">
        <select name="action" aria-label="处理方式"><option value="include">改为入选</option><option value="retain">必选保留</option><option value="filter">过滤掉</option><option value="lock">锁定当前判定</option></select>
        <input name="reason" required placeholder="原因" aria-label="原因" style="width:120px"><button>保存</button></form></td></tr>`;
  };
  const body = `
  ${o.notice ? `<div class="note">${esc(o.notice)}</div>` : ''}
  <div class="page-h"><h1>${esc(runTitle(r))}</h1><span><a href="/runs">← 日报记录</a></span></div>
  <div class="cards">
    <div class="card"><span class="l">状态</span><span>${runPill(r, o.queued)}</span><span class="d">${esc(r.stage ?? '')}</span></div>
    <div class="card"><span class="l">候选 / 入选</span><span class="n">${num(r.cands)} / ${r.items ?? '—'}</span></div>
    <div class="card"><span class="l">用时</span><span class="n">${runDur(r)}</span><span class="d">${r.started_at ? `${fmtTime(Date.parse(r.started_at), true)} 开始` : '未开始'}</span></div>
    <div class="card"><span class="l">投递</span><span class="n">${r.sent_at ? fmtTime(Date.parse(r.sent_at), true) : '—'}</span><span class="d">${r.sent_at ? `邮件已送达${r.resends ? `，补发 ${r.resends} 次` : ''}` : '尚未送达'}</span></div>
  </div>
  ${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}
  ${actions ? `<div class="stack" style="grid-auto-flow:column;justify-content:start">${actions}</div>
  <p class="sub">${r.status !== 'succeeded' ? '重新运行会走完整流程：已完成的 AI 判定会复用，只补做未完成的部分。' : ''}${r.brief_id ? '重新发送会把这一期再发一次到收件邮箱。' : ''}</p>` : ''}
  ${o.deliveries.length ? `<h2>投递记录</h2><div class="tw"><table><tr><th>类型</th><th>状态</th><th>时间</th><th>错误</th></tr>${o.deliveries.map(d =>
    `<tr><td>${d.delivery_type === 'primary' ? '首次投递' : d.delivery_type === 'resend' ? `补发 #${d.resend_sequence}` : esc(d.delivery_type)}</td>
     <td>${d.status === 'sent' ? '<span class="pill ok">已送达</span>' : `<span class="pill bad">${esc(d.status)}</span>`}</td>
     <td>${fmtTime(Date.parse(d.sent_at ?? d.created_at), true)}</td><td class="muted">${esc(d.error ?? '')}</td></tr>`).join('')}</table></div>` : ''}
  <h2>候选内容</h2>
  <p class="sub">人工处理在下一次运行或重新运行时生效；选择“锁定当前判定”可防止 AI 重新判定时改变结果。</p>
  ${groups.map(([d, xs]) => {
    const label = d === 'other' ? '其他' : DECISION[d]![0];
    const table = `<div class="tw"><table><tr><th>标题</th><th>判定</th><th>理由</th><th>人工处理</th></tr>${xs.map(cRow).join('')}</table></div>`;
    return d === 'filter' ? `<details><summary>${esc(label)} · ${xs.length} 条</summary>${table}</details>` : `<h2>${esc(label)} · ${xs.length} 条</h2>${table}`;
  }).join('') || '<p class="muted">这次运行没有候选内容。</p>'}`;
  return layout('日报记录', body, o.csrf, 'runs');
}

// ---------------- 订阅输出（后台改版第二期） ----------------

export type FeedRow = { group: string; name: string; note: string; url: string | null; lastAt: string | null;
  action: string; csrfExtra?: string; empty?: string };

export function renderFeeds(o: { csrf: string; now: number; feeds: FeedRow[] }): string {
  const csrf = `<input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="redirect" value="/feeds">`;
  const groups = [...new Set(o.feeds.map(f => f.group))];
  const row = (f: FeedRow) => `<tr><td><b>${esc(f.name)}</b><small>${esc(f.note)}</small></td>
    <td>${f.lastAt ? esc(ago(f.lastAt)) : `<span class="muted">${esc(f.empty ?? '尚无内容')}</span>`}</td>
    <td style="min-width:260px">${f.url ? `<input class="feed" readonly value="${esc(f.url)}" aria-label="${esc(f.name)} 订阅地址">` : '<span class="muted">令牌已撤销</span>'}</td>
    <td><form class="inline" method="post" action="${esc(f.action)}">${csrf}<button name="action" value="reset">${f.url ? '重置' : '生成'}</button>${f.url ? '<button name="action" value="revoke">撤销</button>' : ''}</form></td></tr>`;
  const body = `
  <div class="page-h"><h1>订阅输出</h1><span>所有 RSS 订阅地址</span></div>
  <p class="sub">地址里包含访问令牌，知道地址的人都能读取内容，请勿公开。重置后旧地址立即失效，需要在阅读器里换成新地址。</p>
  ${groups.map(g => `<h2>${esc(g)}</h2><div class="tw"><table><tr><th>订阅</th><th>最近更新</th><th>地址</th><th></th></tr>${o.feeds.filter(f => f.group === g).map(row).join('')}</table></div>`).join('')}`;
  return layout('订阅输出', body, o.csrf, 'feeds');
}
