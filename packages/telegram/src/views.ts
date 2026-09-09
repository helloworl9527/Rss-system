import { esc, layout } from '../../web/src/views.ts';

export function renderTelegram(o: { csrf:string; sources:any[]; settings:any; worker:any; baseUrl:string; saved?:string; error?:string }): string {
  const feed = (token: string | null, all=false) => token ? `${o.baseUrl}/rss/telegram/${all?'all':'source'}/${token}` : '';
  const rows=o.sources.map(s=>`<tr><td>${esc(s.display_name||s.title||s.reference)}<div class="muted">${esc(s.reference)}${s.chat_id?` · ${esc(s.chat_id)}`:''}</div></td>
    <td>${s.source_type==='url'?'仅 URL':'普通总结'}</td><td>${esc(s.status)}${s.last_error?`<div class="bad">${esc(s.last_error)}</div>`:''}<div class="muted">最近成功：${esc(s.last_success_at||'—')}</div></td>
    <td><form class="inline" method="post" action="/telegram/sources/${s.id}/${s.status==='error'?'retry':'toggle'}"><input type="hidden" name="csrf" value="${esc(o.csrf)}">${s.status==='error'?'<button>重试验证</button>':`<input type="hidden" name="enabled" value="${s.enabled?'false':'true'}"><button>${s.enabled?'停用':'启用'}</button>`}</form></td>
    <td>${s.source_type==='url'?'不提供 RSS':`${s.rss_token?`<input readonly value="${esc(feed(s.rss_token))}" style="width:100%">`:'令牌已撤销'}<form class="inline" method="post" action="/telegram/sources/${s.id}/token"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button name="action" value="reset">重置</button><button name="action" value="revoke">撤销</button></form>`}</td></tr>`).join('');
  return layout('Telegram 订阅', `${o.saved?`<div class="note">${esc(o.saved)}</div>`:''}${o.error?`<div class="err">${esc(o.error)}</div>`:''}
    <h2>Telegram 登录</h2><p>状态：${esc(o.worker.login_state)} · ${o.worker.authorized?'已授权':'未授权'} ${o.worker.account_hint?`· ${esc(o.worker.account_hint)}`:''}</p>
    <p class="sub">API ID、API Hash 与手机号在“设置”页进入共享 AES-GCM 保管库。验证码及 2FA 密码仅通过本机 Unix Socket 传输，不写入数据库或日志。</p>
    <form class="inline" method="post" action="/telegram/login/start"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button>开始登录 / 检查会话</button></form>
    <form class="inline" method="post" action="/telegram/login/code"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="password" name="value" inputmode="numeric" autocomplete="one-time-code" placeholder="登录验证码" required><button>提交验证码</button></form>
    <form class="inline" method="post" action="/telegram/login/password"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="password" name="value" autocomplete="current-password" placeholder="Telegram 2FA 密码" required><button>提交 2FA</button></form>
    <h2>新增来源</h2><p class="sub">支持 @username、t.me/username、t.me/s/username、已加入私群的邀请链接及 t.me/c/… 消息链接。系统绝不自动加入群组。</p>
    <form class="inline" method="post" action="/telegram/sources"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input name="display_name" placeholder="显示名（可选）"><input name="reference" required placeholder="@username 或 t.me/…" style="width:280px"><select name="source_type"><option value="normal">普通总结</option><option value="url">仅提取 URL</option></select><button class="primary">添加并异步验证</button></form>
    <h2>来源</h2><table><tr><th>来源</th><th>类型</th><th>状态</th><th>采集</th><th>RSS</th></tr>${rows||'<tr><td colspan="5">暂无来源</td></tr>'}</table>
    <h2>汇总 RSS</h2>${o.settings.all_rss_token?`<input readonly value="${esc(feed(o.settings.all_rss_token,true))}" style="width:100%">`:'令牌已撤销'}
    <form class="inline" method="post" action="/telegram/rss/all/token"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button name="action" value="reset">重置令牌</button><button name="action" value="revoke">撤销令牌</button></form>
    <h2>总结设置</h2><form method="post" action="/telegram/settings"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><table>
    <tr><td>业务时区</td><td><input name="timezone" value="${esc(o.settings.timezone)}"></td></tr><tr><td>关闭时刻</td><td><input name="schedule" value="${esc(JSON.parse(o.settings.schedule_json).join(', '))}"></td></tr>
    <tr><td>供应商</td><td><select name="provider">${['mock','openai','openai_compatible','deepseek','qwen','anthropic','gemini'].map(x=>`<option${x===o.settings.provider?' selected':''}>${x}</option>`).join('')}</select></td></tr>
    <tr><td>模型 / Base URL</td><td><input name="model" value="${esc(o.settings.model)}" placeholder="模型 ID"> <input name="base_url" value="${esc(o.settings.base_url||'')}" placeholder="Base URL" style="width:300px"></td></tr>
    <tr><td>共享密钥引用</td><td><select name="credential_ref">${['OPENAI_COMPAT_API_KEY','OPENAI_API_KEY','DEEPSEEK_API_KEY','DASHSCOPE_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY'].map(x=>`<option${x===o.settings.credential_ref?' selected':''}>${x}</option>`).join('')}</select></td></tr>
    <tr><td>额外关注点</td><td><textarea name="prompt_rules" rows="6" style="width:100%">${esc(o.settings.prompt_rules)}</textarea><div class="muted">固定的“仅依据消息、引用 ID/时间”规则不可修改；此处只添加关注点和输出要求。</div></td></tr></table><p><button class="primary">保存设置</button></p></form>`,o.csrf);
}
