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

const safeHref = (u: unknown): string | null => {
  if (!u) return null;
  try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.toString() : null; }
  catch { return null; }
};

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
  <a href="/">仪表盘</a><a href="/sources">来源</a><a href="/runs">运行</a><a href="/audit">审计</a><a href="/settings">设置</a>
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
  harvest_tier: string; consecutive_failures: number; last_success_at: string | null;
  last_http_code: number | null; last_error: string | null; latest_item_at: string | null; enabled: number };

function sourceTable(sources: Src[]): string {
  return `<table><tr><th>来源</th><th>分类</th><th>采集档</th><th>健康</th>
    <th>最近成功</th><th>最新内容</th><th>连败</th><th>最近错误</th></tr>` +
    sources.map(s => `<tr>
      <td>${esc(s.display_name)}<div class="muted">${esc(s.id)}</div></td>
      <td>${esc(s.category)}</td><td>${esc(s.harvest_tier)}</td>
      <td>${healthDot(s.health)}${s.enabled ? '' : ' <span class="pill">已停用</span>'}</td>
      <td>${esc(ago(s.last_success_at))}</td><td>${esc(ago(s.latest_item_at))}</td>
      <td>${s.consecutive_failures || ''}</td>
      <td class="muted">${esc(String(s.last_error ?? '').slice(0, 60))}</td>
    </tr>`).join('') + '</table>';
}

export function renderDashboard(o: {
  csrf: string; sources: Src[]; harvests: any[]; runs: any[]; stats: any;
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
  </div>
  ${bad.length ? `<div class="note">${bad.length} 个来源处于降级或失败状态：${bad.map(b => esc(b.id)).join('、')}</div>` : ''}
  ${s.pendingFulltext ? `<div class="note">待抓原帖全文 ${esc(s.pendingFulltext)} 条</div>` : ''}
  <p class="muted">最近采集：${lastH ? `#${esc(lastH.id)} ${esc(lastH.status)} ${esc(ago(lastH.started_at))}，
    来源 ${esc(lastH.sources_ok)}/${esc(lastH.sources_attempted)}，新条目 ${esc(lastH.new_items)}` : '尚无记录'}
    ｜ 投递：${esc(deliv)}</p>
  <h2>来源健康</h2>${sourceTable(o.sources)}
  <h2>最近运行</h2>${runsTable(o.runs)}`;
  return layout('仪表盘', body, o.csrf);
}

export function renderSources(o: { csrf: string; sources: Src[] }): string {
  const rows = o.sources.map(s => `<tr>
    <td>${esc(s.display_name)}<div class="muted">${esc(s.id)}</div></td>
    <td>${healthDot(s.health)}</td>
    <td>${esc(ago(s.last_success_at))}</td>
    <td>
      <form method="post" action="/sources/${esc(s.id)}/toggle" class="inline">
        <input type="hidden" name="csrf" value="${esc(o.csrf)}">
        <input type="hidden" name="enabled" value="${s.enabled ? 'false' : 'true'}">
        <input type="hidden" name="redirect" value="/sources">
        <input name="reason" placeholder="理由（必填）" required minlength="4">
        <button>${s.enabled ? '停用' : '启用'}</button>
      </form>
    </td></tr>`).join('');
  return layout('来源', `<h2>来源（${o.sources.length}）</h2>${sourceTable(o.sources)}
    <h2>启停</h2>
    <p class="muted">停用后采集器将跳过该源。操作需填理由并写入审计（PRD 19.2）。</p>
    <table><tr><th>来源</th><th>健康</th><th>最近成功</th><th>操作</th></tr>${rows}</table>
    <p class="muted">来源的 URL、端点与采集档配置在 config/sources.yaml，改后执行 npm run sync 同步。</p>`,
    o.csrf);
}

function runsTable(runs: any[]): string {
  if (!runs.length) return '<p class="muted">尚无运行记录。</p>';
  return `<table><tr><th>#</th><th>窗口</th><th>状态</th><th>阶段</th><th>候选</th><th>开始</th></tr>` +
    runs.map(r => `<tr>
      <td><a href="/runs/${esc(r.id)}">${esc(r.id)}</a></td>
      <td>${esc(r.window_key)} <span class="pill">${esc(r.window_label)}</span></td>
      <td class="${r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn'}"><span class="dot" style="background:currentColor"></span>${esc(r.status)}</td>
      <td>${esc(r.stage ?? '—')}</td><td>${esc(r.cands ?? 0)}</td>
      <td>${esc(ago(r.started_at))}</td></tr>`).join('') + '</table>';
}

export function renderRuns(o: { csrf: string; runs: any[]; harvests: any[] }): string {
  const h = `<h2>采集轮次</h2><table><tr><th>#</th><th>状态</th><th>来源</th><th>新条目</th><th>新版本</th><th>开始</th></tr>` +
    o.harvests.map(x => `<tr><td>${esc(x.id)}</td>
      <td class="${x.status === 'succeeded' ? 'ok' : x.status === 'failed' ? 'bad' : 'warn'}"><span class="dot" style="background:currentColor"></span>${esc(x.status)}</td>
      <td>${esc(x.sources_ok)}/${esc(x.sources_attempted)}</td>
      <td>${esc(x.new_items)}</td><td>${esc(x.new_versions)}</td>
      <td>${esc(ago(x.started_at))}</td></tr>`).join('') + '</table>';
  return layout('运行', `<h2>简报运行</h2>${runsTable(o.runs)}${h}`, o.csrf);
}

export function renderRunDetail(o: { csrf: string; run: any; candidates: any[] }): string {
  const csrf = o.csrf;
  const byDec: Record<string, any[]> = {};
  for (const c of o.candidates) (byDec[c.decision] ??= []).push(c);
  const label: Record<string, string> = {
    retain: '强制保留', normal: '普通候选', escalate: '待复核', filter: '已过滤',
  };
  const sections = Object.entries(byDec).map(([dec, list]) => `
    <h2>${esc(label[dec] ?? dec)}（${list.length}）</h2>
    <table><tr><th>来源</th><th>标题</th><th>类别</th><th>补录</th><th>规则/原因</th><th>人工覆盖</th></tr>` +
    list.map(c => {
      const u = safeHref(c.canonical_url);
      const act = dec === 'filter' ? 'include' : 'filter';
      const label = dec === 'filter' ? '收录' : '过滤';
      return `<tr><td>${esc(c.source_id)}</td>
        <td>${u ? `<a href="${esc(u)}" rel="noopener noreferrer">${esc(c.title)}</a>` : esc(c.title)}</td>
        <td>${c.mandatory_class && c.mandatory_class !== 'none' ? `<span class="pill">${esc(c.mandatory_class)}</span>` : '—'}</td>
        <td>${c.late_discovery ? `<span class="pill">补录</span>` : '—'}</td>
        <td class="muted">${esc(c.filter_rule_id ?? '')} ${esc(String(c.filter_reason ?? '').slice(0, 70))}</td>
        <td><form method="post" action="/candidates/${esc(c.id)}/override" class="inline">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <input type="hidden" name="action" value="${act}">
          <input type="hidden" name="redirect" value="/runs/${esc(c.run_id)}">
          <input name="reason" placeholder="理由（必填）" required minlength="4">
          <select name="scope"><option value="once">仅本次</option><option value="permanent">永久规则</option></select>
          <button>${label}</button>
        </form></td>
      </tr>`;
    }).join('') + '</table>').join('');

  const r = o.run;
  return layout(`运行 #${r.id}`, `
    <h2>运行 #${esc(r.id)} · ${esc(r.window_key)} ${esc(r.window_label)}</h2>
    <p class="muted">状态 ${esc(r.status)} ｜ 阶段 ${esc(r.stage ?? '—')} ｜ 触发 ${esc(r.trigger)}
      ｜ 窗口 ${esc(r.window_start_at)} → ${esc(r.window_end_at)}
      ｜ 规则版本 ${esc(r.rule_version ?? '—')}</p>
    ${o.candidates.length ? sections : '<p class="muted">该运行尚无候选。</p>'}`, o.csrf);
}

export function renderAudit(o: { csrf: string; events: any[] }): string {
  const t = o.events.length
    ? `<table><tr><th>时间</th><th>实体</th><th>动作</th><th>详情</th></tr>` +
      o.events.map(e => `<tr><td>${esc(ago(e.created_at))}</td>
        <td>${esc(e.entity_type)} ${esc(e.entity_id)}</td><td>${esc(e.action)}</td>
        <td class="muted">${esc(String(e.payload_json ?? '').slice(0, 120))}</td></tr>`).join('') + '</table>'
    : '<p class="muted">尚无审计事件。</p>';
  return layout('审计', `<h2>审计事件</h2>${t}`, o.csrf);
}

const PROVIDERS = [
  ['mock', 'mock（本地假响应，不花钱）'],
  ['deepseek', 'DeepSeek'],
  ['openai', 'OpenAI'],
  ['qwen', 'Qwen（DashScope 兼容模式）'],
  ['anthropic', 'Anthropic'],
  ['gemini', 'Gemini'],
];
const KEY_LABEL: Record<string, string> = {
  OPENAI_API_KEY: 'OpenAI', DEEPSEEK_API_KEY: 'DeepSeek', DASHSCOPE_API_KEY: 'Qwen / DashScope',
  ANTHROPIC_API_KEY: 'Anthropic', GEMINI_API_KEY: 'Gemini',
};

export function renderSettings(o: {
  csrf: string;
  vaultOk: boolean; vaultReason?: string;
  secrets: Array<{ name: string; set: boolean; hint: string }>;
  settings: Record<string, string | undefined>;
  envOverrides: string[];
  saved?: string; error?: string;
}): string {
  const cur = o.settings.aiProvider ?? 'mock';
  const providerOpts = PROVIDERS.map(([v, label]) =>
    `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`).join('');

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

  <h2>AI 供应商</h2>
  <form method="post" action="/settings/ai">
    <input type="hidden" name="csrf" value="${esc(o.csrf)}">
    <table><tr><th>层级</th><th>用途</th><th>供应商</th><th>模型 ID</th></tr>
      <tr><td>L1</td><td class="muted">批量判定，单期约 80 条 —— 花钱大头</td>
        <td><select name="ai_provider">${providerOpts}</select></td>
        <td><input name="l1_model" value="${esc(o.settings.l1Model ?? '')}" placeholder="模型 ID" style="width:200px"></td></tr>
      <tr><td>L2</td><td class="muted">复核，单期最多 5 条</td>
        <td><input name="l2_provider" value="${esc(o.settings.l2Provider ?? '')}" placeholder="留空则同 L1" style="width:130px"></td>
        <td><input name="l2_model" value="${esc(o.settings.l2Model ?? '')}" placeholder="留空则同 L1" style="width:200px"></td></tr>
      <tr><td>L3</td><td class="muted">高风险，单期最多 2 条</td>
        <td><input name="l3_provider" value="${esc(o.settings.l3Provider ?? '')}" placeholder="留空则同 L1" style="width:130px"></td>
        <td><input name="l3_model" value="${esc(o.settings.l3Model ?? '')}" placeholder="留空则同 L1" style="width:200px"></td></tr>
    </table>
    <p><button class="primary" ${o.vaultOk ? '' : 'disabled'}>保存供应商设置</button></p>
  </form>

  <h2>API Key</h2>
  <p class="muted">加密存于 /var/lib/briefing/secrets.enc（0600），主密钥在 root 控制的
    /etc/briefing/env 中。页面只显示末四位，任何情况下不回显明文。</p>
  <table><tr><th>厂商</th><th>状态</th><th>设置</th></tr>${keyRows}</table>`;
  return layout('设置', body, o.csrf);
}
