/**
 * 设置页「模型供应商」「模型分配」两节（docs/model-providers-design.md 第 10 节）。
 * 页面不用脚本（CSP 禁止）：模型候选用一个合并的 datalist。密钥只显示是否已设置与末四位（长度 ≥16 才显示）。
 */
import { esc } from './views.ts';
import {
  CONSUMERS, CONSUMER_LABEL, PROVIDER_TYPES, PROVIDER_TYPE_LABEL, FOLLOW_RULES, DISABLE_ALLOWED, CAPABILITY, OFFICIAL_BASE,
  type AssignmentRow, type Consumer, type ProviderRow,
} from '../../ai/src/model-config.ts';
import { REASONING_EFFORTS, reasoningSupport } from '../../ai/src/reasoning.ts';
import { MODELS_ERROR_LABEL } from './model-catalog.ts';

export type ConsumerStatus = { consumer: Consumer; text: string; ok: boolean };
export type ModelsView = {
  csrf: string; enabled: boolean; revision: number; keyOk: boolean; keyProblem?: string | null;
  providers: Array<ProviderRow & { baseUrl: string | null }>;
  assignments: AssignmentRow[];
  /** 每个使用方当前实际生效的配置摘要（不含密钥与地址路径） */
  status: ConsumerStatus[];
};

const hidden = (csrf: string, revision: number) => `<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="revision" value="${revision}">`;
const typeOpts = (sel: string) => PROVIDER_TYPES.map(t => `<option value="${t}"${t === sel ? ' selected' : ''}>${esc(PROVIDER_TYPE_LABEL[t])}</option>`).join('');
const parse = (j: string | null): any => { try { return JSON.parse(j ?? 'null'); } catch { return null; } };

export function renderModelsSection(v: ModelsView): string {
  const h = hidden(v.csrf, v.revision);
  const usedBy = (id: string) => v.assignments.filter(a => a.provider_id === id).map(a => CONSUMER_LABEL[a.consumer]);
  const state = v.enabled
    ? `<p><span class="ok">已启用</span>：日报、Telegram、来源画像、向量模型都只使用下方的供应商与分配，不再读取环境变量与各处旧设置。</p>
       <form method="post" action="/settings/models/enable" class="inline">${h}<input type="hidden" name="enabled" value="0">
       <button>停用，回到旧配置</button> <span class="muted">供应商与分配保留；旧配置（env 等）仍在时才可安全停用</span></form>`
    : `<p><span class="muted">未启用</span>：当前仍使用旧配置（环境变量与各处设置）。${v.providers.length ? '分配齐全后可启用。' : '可以一键从当前配置导入。'}</p>
       ${v.providers.length ? `<form method="post" action="/settings/models/enable" class="inline">${h}<input type="hidden" name="enabled" value="1"><button class="primary">启用全局模型供应商</button></form>`
         : `<form method="post" action="/settings/models/import" class="inline">${h}<button class="primary"${v.keyOk ? '' : ' disabled'}>从当前配置导入</button>
           <span class="muted">按当前实际生效的配置生成供应商与分配，逐项比对一致后才启用；任一用途无法导入则什么都不改</span></form>`}`;

  const providerRows = v.providers.map(p => {
    const models = parse(p.models_json) ?? [], manual = parse(p.manual_models_json) ?? [];
    const err = parse(p.models_error_json);
    const stale = p.models_for !== null && p.models_for !== p.config_version;
    const users = usedBy(p.id);
    return `<tr>
      <td>${esc(p.name)}<div class="muted">${esc(p.id)}</div></td>
      <td>${esc(PROVIDER_TYPE_LABEL[p.type])}<div class="muted">${esc(p.base_host || '官方地址')}</div></td>
      <td>${p.key_ct ? `<span class="ok">已设置</span>${p.key_hint ? ` <span class="muted">…${esc(p.key_hint)}</span>` : ''}` : '<span class="bad">未设置</span>'}</td>
      <td>${models.length} 个${manual.length ? ` + 手动 ${manual.length}` : ''}${stale ? ' <span class="bad">已过期，需刷新</span>' : ''}${p.models_truncated ? ' <span class="muted">（列表不完整）</span>' : ''}
        <div class="muted">${p.models_fetched_at ? `最近拉取 ${esc(p.models_fetched_at.slice(0, 16).replace('T', ' '))} UTC` : '尚未拉取'}${err ? `；<span class="bad">${esc(MODELS_ERROR_LABEL[err.kind] ?? err.kind)}</span>` : ''}</div></td>
      <td>${users.length ? esc(users.join('、')) : '<span class="muted">未使用</span>'}</td>
      <td>
        <form method="post" action="/settings/models/providers/${esc(p.id)}/refresh" class="inline">${h}<button>刷新模型列表</button></form>
        ${users.length ? '' : `<form method="post" action="/settings/models/providers/${esc(p.id)}/delete" class="inline">${h}<button>删除</button></form>`}
        <details><summary>编辑</summary>
          <form method="post" action="/settings/models/providers/${esc(p.id)}">${h}<table>
            <tr><td>名称</td><td><input name="name" value="${esc(p.name)}" maxlength="40" style="width:220px"></td></tr>
            <tr><td>类型</td><td><select name="type">${typeOpts(p.type)}</select></td></tr>
            <tr><td>Base URL</td><td><input name="base_url" value="${esc(p.baseUrl ?? '')}" style="width:340px" placeholder="留空 = 官方地址">${p.baseUrl === null ? '<div class="bad">原地址无法解密，请重新填写</div>' : ''}</td></tr>
            <tr><td>密钥</td><td><input type="password" name="api_key" autocomplete="off" style="width:260px" placeholder="留空 = 不修改">
              <label><input type="checkbox" name="clear_key" value="1"> 清除密钥</label><div class="muted">修改类型或 Base URL 时必须重新填写密钥</div></td></tr>
          </table><p><button class="primary">保存</button></p></form>
          <form method="post" action="/settings/models/providers/${esc(p.id)}/manual">${h}
            <p>手动补充的模型（每行一个，最多 100 个）：</p><textarea name="models" rows="3" style="width:100%">${esc(manual.join('\n'))}</textarea>
            <p><button>保存手动模型</button></p></form>
        </details>
      </td></tr>`;
  }).join('');

  const allModels = [...new Set(v.providers.flatMap(p => [...(parse(p.models_json) ?? []), ...(parse(p.manual_models_json) ?? [])]))].sort();
  const byConsumer = new Map(v.assignments.map(a => [a.consumer, a]));
  const statusOf = new Map(v.status.map(s => [s.consumer, s]));
  const assignRows = CONSUMERS.map(c => {
    const a = byConsumer.get(c);
    const cur = !a ? '' : a.disabled ? 'disabled' : a.follow ? `follow:${a.follow}` : `p:${a.provider_id}`;
    const allowed = CAPABILITY[c];
    const opts = [
      ...FOLLOW_RULES[c].map(f => [`follow:${f}`, `跟随 ${f.toUpperCase()}`]),
      ...(DISABLE_ALLOWED.has(c) ? [['disabled', c === 'sourceProfiler' ? '停用（使用模拟画像）' : '停用']] : []),
      ...v.providers.filter(p => !allowed || allowed.has(p.type)).map(p => [`p:${p.id}`, `${p.name}（${PROVIDER_TYPE_LABEL[p.type]}）`]),
    ];
    const st = statusOf.get(c);
    const providerType = a?.provider_id ? v.providers.find(p => p.id === a.provider_id)?.type : undefined;
    const verifiedExplicit = c !== 'embedding' && !a?.disabled && !a?.follow && !!providerType && !!a?.model && !!reasoningSupport(providerType, a.model);
    // 没分配或正在跟随的行保持「跟随/默认」，避免一次保存把跟随写成固定覆盖。已核实的显式模型即使库里还是空，也显示 medium。
    const selectedEffort = a?.reasoning_effort || (verifiedExplicit ? 'medium' : '');
    const effortOpts = [['', '跟随上游；已核实模型默认 medium；未核实则不发送'], ...REASONING_EFFORTS.map(e => [e, e === 'medium' ? 'medium（默认）' : e])];
    return `<tr><td>${esc(CONSUMER_LABEL[c])}${allowed ? '<div class="muted">只能用 OpenAI 兼容协议</div>' : ''}</td>
      <td><select name="${c}_target"><option value="">（未分配）</option>${opts.map(([val, label]) => `<option value="${esc(val)}"${val === cur ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></td>
      <td><input name="${c}_model" list="model-candidates" value="${esc(a?.model ?? '')}" placeholder="模型 ID（跟随 / 停用时留空）" style="width:220px"></td>
      <td><select name="${c}_strictness">${[['', '按类型默认'], ['strict', 'strict'], ['json', 'json'], ['none', 'none']].map(([val, label]) => `<option value="${val}"${(a?.strictness ?? '') === val ? ' selected' : ''}>${label}</option>`).join('')}</select>
        <div class="muted">只控制 JSON 结构</div></td>
      <td><select name="${c}_reasoning">${effortOpts.map(([val, label]) => `<option value="${esc(val)}"${val === selectedEffort ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
        <div class="muted">${c === 'embedding' ? '向量接口不使用' : '留空=跟随或默认'}</div></td>
      <td>${st ? `<span class="${st.ok ? 'muted' : 'bad'}">${esc(st.text)}</span>` : ''}</td></tr>`;
  }).join('');

  return `
  <h2 id="models">模型供应商</h2>
  <p class="sub">所有需要调用模型的地方只选「供应商 + 模型」。密钥与完整 Base URL 加密存放在日报数据库中（主密钥 APP_ENCRYPTION_KEY 不在库里）。</p>
  ${v.keyOk ? '' : '<div class="err">未设置 APP_ENCRYPTION_KEY：无法保存或读取供应商密钥。</div>'}
  ${v.keyOk && v.keyProblem ? `<div class="err">${esc(v.keyProblem)}。主密钥太弱时不能新增供应商或导入。</div>` : ''}
  ${state}
  <table><tr><th>名称</th><th>类型 / 主机</th><th>密钥</th><th>模型列表</th><th>使用方</th><th>操作</th></tr>
    ${providerRows || '<tr><td colspan="6" class="muted">还没有供应商</td></tr>'}</table>
  <details><summary>新增供应商</summary>
    <form method="post" action="/settings/models/providers">${h}<table>
      <tr><td>名称</td><td><input name="name" maxlength="40" style="width:220px" required></td></tr>
      <tr><td>类型</td><td><select name="type">${typeOpts('openai_compatible')}</select></td></tr>
      <tr><td>Base URL</td><td><input name="base_url" style="width:340px" placeholder="OpenAI 兼容必填；其他类型留空 = 官方地址">
        <div class="muted">只允许 https 域名地址。默认：${PROVIDER_TYPES.filter(t => OFFICIAL_BASE[t]).map(t => `${esc(PROVIDER_TYPE_LABEL[t])} ${esc(OFFICIAL_BASE[t])}`).join('；')}</div></td></tr>
      <tr><td>密钥</td><td><input type="password" name="api_key" autocomplete="off" style="width:260px" required></td></tr>
    </table><p><button class="primary"${v.keyOk ? '' : ' disabled'}>保存并拉取模型列表</button></p></form>
  </details>

  <h2 id="model-assign">模型分配</h2>
  <p class="sub">每个用途选择供应商与模型，或跟随 L1 / L2。保存时会检查完整的跟随关系与类型限制（图片识别、向量只能用 OpenAI 兼容协议）。${v.enabled ? '' : '未启用时这里的分配不生效。'}</p>
  <p class="sub">思考程度（reasoning_effort）只决定推理深度，和「结构化输出」不是一回事。已核实的 GPT 推理模型会把所选值写入 Chat Completions；显式分配留空时保存为 medium，跟随 L1/L2 时留空表示继承，单独选择则只覆盖本阶段。未核实的模型（包括以前用过的 Grok、Gemini）若选了具体程度，保存会被拒绝，不会悄悄丢掉，也不会把参数发给供应商。思考程度不是 none 时，请求不再附带 temperature 和 top_p；max_tokens 与输出 schema 不变。</p>
  <p class="muted">已核实：gpt-6.1-terra 支持 none/low/medium/high/xhigh/max；gpt-6-astra 与 gpt-6.1-sol 不支持 none；gpt-6-sol、gpt-6-luna 支持 none 到 max；gpt-5 与 gpt-5-2025-08-07 支持 minimal/low/medium/high；gpt-6.2-sol 支持 low/medium/high/xhigh，官方拒绝 none，minimal 也不接受。留空仍保存为 medium，不会因为 gpt-6.2-sol 把其它模型改成 high。依据 OpenAI 文档（gpt-6.2-sol 为 2026-11-19）。网关模型写成 vendor/上述 ID 时同样认。其他模型一律不发送该参数。</p>
  <datalist id="model-candidates">${allModels.map(m => `<option value="${esc(m)}">`).join('')}</datalist>
  <form method="post" action="/settings/models/assignments">${h}
    <table><tr><th>用途</th><th>供应商</th><th>模型</th><th>结构化输出</th><th>思考程度</th><th>当前生效</th></tr>${assignRows}</table>
    <p><button class="primary">保存分配</button></p></form>
  <form method="post" action="/settings/models/test">${h}
    <p><select name="consumer">${CONSUMERS.map(c => `<option value="${c}">${esc(CONSUMER_LABEL[c])}</option>`).join('')}</select>
    <button>测试当前生效配置</button> <span class="muted">发一次很小的请求，显示是否成功与耗时</span></p></form>`;
}
