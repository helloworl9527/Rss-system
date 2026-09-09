/**
 * 服务端渲染的后台页面（PRD 16）。
 *
 * 单用户后台不需要 SPA —— 服务端渲染省掉构建链、省内存，
 * 且 CSP 可以完全禁掉脚本（default-src 'none'），攻击面最小。
 * 所有动态值一律转义：数据库里存的是来源方提供的不可信文本。
 */

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
:root{
  color-scheme:light dark;
  --page:#f2f5f8; --card:#fff; --line:#e2e7ee; --line-soft:#eef1f5;
  --ink:#161b22; --body:#39424e; --muted:#6b7684; --faint:#8b95a3;
  --accent:#1c5fa8; --accent-soft:#e7eef7;
  --ok:#12764a; --warn:#96590a; --bad:#b3261e;
  --nav:#1a1f27;
}
@media(prefers-color-scheme:dark){:root{
  --page:#12161b; --card:#1a2027; --line:#2b333d; --line-soft:#232a32;
  --ink:#e8edf3; --body:#c3cbd5; --muted:#8b95a3; --faint:#6b7684;
  --accent:#7fb0e8; --accent-soft:#1d2a3a;
  --ok:#4cc38a; --warn:#e0a33e; --bad:#f3796e; --nav:#0f1318;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--body);
  font:15px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
  -webkit-font-smoothing:antialiased}

header{background:var(--nav);padding:0 22px;display:flex;align-items:center;gap:4px;flex-wrap:wrap}
header .brand{font-weight:700;color:#fff;font-size:15px;letter-spacing:-.01em;margin-right:18px;padding:14px 0}
header a{color:#9aa7b5;text-decoration:none;font-size:14px;padding:15px 12px;display:block;
  border-bottom:2px solid transparent;transition:color .12s}
header a:hover{color:#fff}
header form{margin-left:auto}
header form button{background:transparent;border:1px solid #39424e;color:#9aa7b5;font-size:13px;padding:5px 13px}
header form button:hover{color:#fff;border-color:#5b6875}

main{max-width:1120px;margin:0 auto;padding:26px 22px 60px}
h2{font-size:12px;letter-spacing:.11em;text-transform:uppercase;color:var(--muted);
  font-weight:700;margin:34px 0 12px}
h2:first-child{margin-top:0}
.sub{font-size:13px;color:var(--muted);margin:-6px 0 14px}

.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:12px;margin:0 0 6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:15px 17px}
.card .n{font-size:26px;font-weight:700;color:var(--ink);letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;line-height:1.2}
.card .l{font-size:12px;color:var(--muted);margin-top:3px}

table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);
  border:1px solid var(--line);border-radius:10px;overflow:hidden}
th{background:transparent;font-weight:600;font-size:11px;letter-spacing:.07em;text-transform:uppercase;
  color:var(--faint);padding:11px 14px;text-align:left;border-bottom:1px solid var(--line)}
td{padding:11px 14px;font-size:14px;border-bottom:1px solid var(--line-soft);vertical-align:top;color:var(--body)}
tr:last-child td{border-bottom:none}
tbody tr:hover td,table tr:hover td{background:var(--line-soft)}
td a{color:var(--accent);text-decoration:none}
td a:hover{text-decoration:underline}

.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.muted{color:var(--muted);font-size:12.5px;line-height:1.55}
.pill{display:inline-block;padding:2px 8px;border-radius:11px;font-size:11px;
  background:var(--line-soft);color:var(--muted)}
.pill.accent{background:var(--accent-soft);color:var(--accent)}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px}

button{font:inherit;font-size:13px;padding:6px 14px;border:1px solid var(--line);
  background:var(--card);color:var(--body);border-radius:7px;cursor:pointer;transition:border-color .12s}
button:hover{border-color:var(--muted)}
button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:500}
button.primary:hover{opacity:.9}

input,select{font:inherit;font-size:13px;padding:6px 9px;border:1px solid var(--line);
  border-radius:7px;background:var(--card);color:var(--ink)}
input:focus,select:focus{outline:2px solid var(--accent-soft);outline-offset:0;border-color:var(--accent)}
input::placeholder{color:var(--faint)}
form.inline{display:flex;gap:6px;align-items:center;margin:0;flex-wrap:wrap}
form.inline input[name=reason]{width:158px}
details{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:10px 0;overflow:hidden}
summary{cursor:pointer;padding:11px 14px;font-weight:650;color:var(--ink)}
details>table{border-width:1px 0 0;border-radius:0}
details.vendor{margin:8px 12px 12px}

form.login{max-width:352px;margin:11vh auto;background:var(--card);border:1px solid var(--line);
  border-radius:14px;padding:30px 28px}
form.login h2{font-size:19px;text-transform:none;letter-spacing:-.01em;color:var(--ink);margin:0 0 4px}
form.login .hint{font-size:13px;color:var(--muted);margin:0 0 20px}
form.login label{display:block;font-size:12px;color:var(--muted);margin:14px 0 5px;font-weight:500}
form.login input{width:100%;padding:10px 12px;font-size:14px}
form.login button{width:100%;padding:11px;margin-top:22px;font-size:14px}

.err,.note{padding:11px 14px;border-radius:9px;font-size:13.5px;line-height:1.6;margin:0 0 16px}
.err{background:color-mix(in srgb,var(--bad) 10%,transparent);border:1px solid color-mix(in srgb,var(--bad) 32%,transparent);color:var(--bad)}
.note{background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 24%,transparent);color:var(--body)}
a{color:var(--accent)}
@media(max-width:640px){
  main{padding:18px 14px 40px}
  header{padding:0 14px}
  th,td{padding:9px 10px;font-size:13px}
  form.inline input[name=reason]{width:110px}
}`;

export function layout(title: string, body: string, csrf: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 十六源简报后台</title><style>${CSS}</style></head><body>
<header>
  <span class="brand">十六源简报</span>
  <a href="/">仪表盘</a><a href="/sources">来源</a><a href="/allnet">全网热点</a><a href="/telegram">Telegram 订阅</a><a href="/settings">设置</a>
  <form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>登出</button></form>
</header><main>${body}</main></body></html>`;
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

function sourceTable(sources: Src[]): string {
  return `<table><tr><th>来源</th><th>分类</th><th>采集档</th><th>健康</th>
    <th>最近成功</th><th>最新内容</th><th>连败</th><th>最近错误</th></tr>` +
    sources.map(s => `<tr>
      <td>${esc(s.display_name)}<div class="muted">${esc(s.id)}</div></td>
      <td>${esc(s.category)}</td><td>${esc(s.harvest_tier)}</td>
      <td>${healthDot(s.health)} <span class="pill">${esc(s.onboarding_status ?? (s.enabled ? 'ACTIVE' : 'DISABLED'))}</span>${s.enabled ? '' : `<span class="pill">${s.allnet_json?'未参与日报':'已停用'}</span>`}</td>
      <td>${esc(ago(s.last_success_at))}</td><td>${esc(ago(s.latest_item_at))}</td>
      <td>${s.consecutive_failures || ''}</td>
      <td class="muted">${esc(String(s.last_error ?? '').slice(0, 60))}</td>
    </tr>`).join('') + '</table>';
}

export function renderDashboard(o: {
  csrf: string; sources: Src[]; harvests: any[]; stats: any;
}): string {
  const s = o.stats;
  const bad = o.sources.filter(x => x.health === 'failing' || x.health === 'degraded');
  const lastH = o.harvests[0];
  const deliv = (s.deliveries ?? []).map((d: any) => `${d.status} ${d.c}`).join(' · ') || '尚无投递';

  const body = `
  <div class="cards">
    <div class="card"><div class="n">${o.sources.filter(x => x.health === 'healthy').length}/${o.sources.length}</div><div class="l">来源健康</div></div>
    <div class="card"><div class="n">${esc(s.items)}</div><div class="l">条目</div></div>
    <div class="card"><div class="n">${esc(s.versions)}</div><div class="l">版本</div></div>
    <div class="card"><div class="n">${esc(s.candidates)}</div><div class="l">候选</div></div>
    <div class="card"><div class="n">${esc(s.onboardingPending ?? 0)}</div><div class="l">待审批来源</div></div>
    <div class="card"><div class="n">${esc(s.profilerCalls ?? 0)}</div><div class="l">Profiler 调用</div></div>
  </div>
  ${bad.length ? `<div class="note">${bad.length} 个来源处于降级或失败状态：${bad.map(b => esc(b.id)).join('、')}</div>` : ''}
  ${s.pendingFulltext ? `<div class="note">待抓原帖全文 ${esc(s.pendingFulltext)} 条</div>` : ''}
  <p class="muted">最近采集：${lastH ? `#${esc(lastH.id)} ${esc(lastH.status)} ${esc(ago(lastH.started_at))}，
    来源 ${esc(lastH.sources_ok)}/${esc(lastH.sources_attempted)}，新条目 ${esc(lastH.new_items)}` : '尚无记录'}
    ｜ 投递：${esc(deliv)} ｜ AI token：${esc(s.aiTokens ?? 0)} ｜ 成本：$${Number(s.aiCostUsd ?? 0).toFixed(4)}</p>
  <h2>来源健康</h2>${sourceTable(o.sources)}`;
  return layout('仪表盘', body, o.csrf);
}

const PARSERS = [['rss','RSS / Atom'],['telegram_web','Telegram 网页版 (t.me/s/…)'],
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
    return `<details class="vendor" open><summary>${esc(label)}（${rows.length}）</summary>${manageTable(rows)}</details>`;
  }).join('');
  const vendorCount = o.sources.filter(s => !['unclassified','zhihu','weibo','baidu'].includes(s.source_group)).length;
  const unclassified = o.sources.filter(s => s.source_group === 'unclassified');
  const groupedSources = `<details open><summary>科技厂商（${vendorCount}）</summary>${vendors}</details>
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

  <h2>RSS 来源分类</h2>
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

  <h2>AI 模型与 API 地址</h2>
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

  <h2>API Key</h2>
  <p class="muted">加密存于 /var/lib/briefing/secrets.enc（0600），主密钥在 root 控制的
    /etc/briefing/env 中。页面只显示末四位，任何情况下不回显明文。</p>
  <table><tr><th>厂商</th><th>状态</th><th>设置</th></tr>${keyRows}</table>

  <h2>Source Profiler（独立于 L1/L2/L3）</h2>
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
  return layout('设置', body + `<h2>全网热点</h2><p>在上方密钥保管库保存或更新 ALLNET_API_KEY。全网热点页可按名称订阅。</p><form method="post" action="/settings/allnet/test"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button>测试连通性</button></form>`, o.csrf);
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
