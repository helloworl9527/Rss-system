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
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
 background:#f4f6f8;color:#1f2933}
header{background:#1f2933;color:#fff;padding:10px 18px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
header a{color:#c9d6e2;text-decoration:none;font-size:14px}
header a:hover{color:#fff;text-decoration:underline}
header .brand{font-weight:700;color:#fff;margin-right:8px}
header form{margin-left:auto}
main{max-width:1100px;margin:0 auto;padding:18px}
h2{font-size:17px;margin:22px 0 10px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dfe4ea;border-radius:6px;overflow:hidden}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eef1f4;font-size:14px;vertical-align:top}
th{background:#eceff2;font-weight:600;font-size:13px}
tr:last-child td{border-bottom:none}
.cards{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 8px}
.card{background:#fff;border:1px solid #dfe4ea;border-radius:6px;padding:12px 14px;min-width:130px;flex:1}
.card .n{font-size:22px;font-weight:700}
.card .l{font-size:12px;color:#5b6875}
.ok{color:#1a7f4b}.warn{color:#a86400}.bad{color:#b3261e}.muted{color:#5b6875;font-size:13px}
.pill{display:inline-block;padding:1px 7px;border:1px solid #dfe4ea;border-radius:3px;font-size:12px;color:#5b6875}
button{font:inherit;padding:5px 12px;border:1px solid #c5ced6;background:#fff;border-radius:4px;cursor:pointer}
form.login{max-width:340px;margin:9vh auto;background:#fff;border:1px solid #dfe4ea;border-radius:8px;padding:22px}
form.login input{width:100%;padding:9px;margin:6px 0 12px;border:1px solid #c5ced6;border-radius:4px;font:inherit}
form.login button{width:100%;padding:9px;background:#1b5fa8;color:#fff;border-color:#1b5fa8}
.err{background:#fdecea;border:1px solid #f5c2bd;color:#b3261e;padding:8px 10px;border-radius:4px;font-size:14px;margin:0 0 12px}
.note{background:#fff8e1;border:1px solid #f0e0a8;padding:8px 10px;border-radius:4px;font-size:13px;margin:0 0 12px}
a{color:#1b5fa8}
form.inline{display:flex;gap:5px;align-items:center;margin:0}
form input[type=password],form input[type=text],form input:not([type]){padding:4px 6px;border:1px solid #c5ced6;border-radius:3px;font:inherit;font-size:13px}
form.inline input[name=reason]{padding:4px 6px;border:1px solid #c5ced6;border-radius:3px;font:inherit;font-size:13px;width:150px}
form.inline select{padding:4px;border:1px solid #c5ced6;border-radius:3px;font:inherit;font-size:13px}
form.inline button{padding:4px 10px;font-size:13px}
@media(prefers-color-scheme:dark){
 body{background:#161b21;color:#e6eaee}
 table,.card,form.login{background:#1e242b;border-color:#2e3742}
 th{background:#252c34}td{border-color:#252c34}
 .note{background:#2a2617;border-color:#4a4227}
 form.inline input,form.inline select{background:#252c34;color:#e6eaee;border-color:#3a4450}
 button{background:#2a323b;color:#e6eaee;border-color:#3a4450}
 .err{background:#3a1f1c;border-color:#5c2f2a;color:#f3b7b1}
 a,header a:hover{color:#8ab4e8}
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
  <h2 style="margin-top:0">十六源简报后台</h2>
  ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
  ${o.configured ? '' : '<div class="note">尚未设置 ADMIN_PASSWORD_HASH，当前为只读演示模式，无法登录。</div>'}
  <label>口令</label>
  <input type="password" name="password" autocomplete="current-password" required>
  ${o.needTotp ? '<label>动态验证码</label><input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required>' : ''}
  <button type="submit">登录</button>
</form></body></html>`;
}

const healthCls = (h: string) => h === 'healthy' ? 'ok' : h === 'degraded' ? 'warn' : h === 'failing' ? 'bad' : 'muted';
const healthTxt = (h: string) => ({ healthy: '正常', degraded: '降级', failing: '失败' }[h] ?? '未知');

type Src = { id: string; display_name: string; category: string; health: string;
  harvest_tier: string; consecutive_failures: number; last_success_at: string | null;
  last_http_code: number | null; last_error: string | null; latest_item_at: string | null; enabled: number };

function sourceTable(sources: Src[]): string {
  return `<table><tr><th>来源</th><th>分类</th><th>采集档</th><th>健康</th>
    <th>最近成功</th><th>最新内容</th><th>连败</th><th>最近错误</th></tr>` +
    sources.map(s => `<tr>
      <td>${esc(s.display_name)}<div class="muted">${esc(s.id)}</div></td>
      <td>${esc(s.category)}</td><td>${esc(s.harvest_tier)}</td>
      <td class="${healthCls(s.health)}">${healthTxt(s.health)}${s.enabled ? '' : ' <span class="pill">已停用</span>'}</td>
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
    <div class="card"><div class="n">${esc(s.evaluations)}</div><div class="l">AI 判定</div></div>
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
    <td class="${healthCls(s.health)}">${healthTxt(s.health)}</td>
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
      <td class="${r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn'}">${esc(r.status)}</td>
      <td>${esc(r.stage ?? '—')}</td><td>${esc(r.cands ?? 0)}</td>
      <td>${esc(ago(r.started_at))}</td></tr>`).join('') + '</table>';
}

export function renderRuns(o: { csrf: string; runs: any[]; harvests: any[] }): string {
  const h = `<h2>采集轮次</h2><table><tr><th>#</th><th>状态</th><th>来源</th><th>新条目</th><th>新版本</th><th>开始</th></tr>` +
    o.harvests.map(x => `<tr><td>${esc(x.id)}</td>
      <td class="${x.status === 'succeeded' ? 'ok' : x.status === 'failed' ? 'bad' : 'warn'}">${esc(x.status)}</td>
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
      <button>保存</button>
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
    <p><button ${o.vaultOk ? '' : 'disabled'}>保存供应商设置</button></p>
  </form>

  <h2>API Key</h2>
  <p class="muted">加密存于 /var/lib/briefing/secrets.enc（0600），主密钥在 root 控制的
    /etc/briefing/env 中。页面只显示末四位，任何情况下不回显明文。</p>
  <table><tr><th>厂商</th><th>状态</th><th>设置</th></tr>${keyRows}</table>`;
  return layout('设置', body, o.csrf);
}
