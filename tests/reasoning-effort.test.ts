// 思考程度：后台可保存、跟随可继承、已核实 GPT 请求显式 medium；未核实模型不发送且不能悄悄丢掉显式设置。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'reasoning-effort-'));
process.env.SECRETS_PATH = join(dir, 'secrets.enc');
process.env.APP_ENCRYPTION_KEY = 'test-master-key-0123456789abcdef';
for (const k of Object.keys(process.env)) if (/^(AI_|OPENAI|ANTHROPIC|GEMINI|DEEPSEEK|DASHSCOPE|EMBEDDING|SOURCE_PROFILER|DEDUP_)/.test(k)) delete process.env[k];

const { openDb, migrate } = await import('../packages/db/src/index.ts');
const mc = await import('../packages/ai/src/model-config.ts');
const mp = await import('../packages/web/src/model-providers.ts');
const reasoning = await import('../packages/ai/src/reasoning.ts');
const { OpenAICompatProvider } = await import('../packages/ai/src/providers/openai-compat.ts');
const { GeminiProvider } = await import('../packages/ai/src/providers/gemini.ts');
const { AnthropicProvider } = await import('../packages/ai/src/providers/anthropic.ts');
const { createProvider, providerFromEnv } = await import('../packages/ai/src/registry.ts');
const { renderModelsSection } = await import('../packages/web/src/model-views.ts');
const { requestEmbeddings } = await import('../packages/ai/src/embeddings.ts');
const { ProviderError } = await import('../packages/ai/src/types.ts');

const KEY = 'sk-reasoning-aaaaaaaaaaaa1111';
const key = mc.currentMasterKey()!;
const fresh = (name: string) => { const db = openDb(join(dir, name)); migrate(db, 'migrations'); return db; };
const chat = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const okJson = { id: 'r', model: 'm', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } };

async function capture(run: () => Promise<unknown>) {
  const orig = globalThis.fetch;
  let body: any = null;
  let calls = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    calls++;
    body = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify(okJson), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  try { await run(); return { body, calls }; }
  finally { globalThis.fetch = orig; }
}

const full = (l1: any, rest: any[] = []): any[] => [l1,
  { consumer: 'l2', mode: 'follow', follow: 'l1' }, { consumer: 'l3', mode: 'follow', follow: 'l2' },
  { consumer: 'telegramSummary', mode: 'follow', follow: 'l1' }, { consumer: 'telegramVision', mode: 'follow', follow: 'l1' },
  { consumer: 'sourceProfiler', mode: 'disabled' }, { consumer: 'embedding', mode: 'disabled' }, ...rest];

try {
  assert.equal(reasoning.reasoningSupport('openai_compatible', 'gpt-6.1-terra')?.efforts.includes('medium'), true);
  assert.equal(reasoning.reasoningSupport('openai', 'openai/gpt-6.1-terra')?.efforts.includes('none'), true);
  assert.equal(reasoning.reasoningSupport('openai_compatible', 'gpt-6-astra')?.efforts.includes('none'), false);
  assert.equal(reasoning.reasoningSupport('gemini', 'gpt-6.1-terra'), null);
  assert.equal(reasoning.reasoningSupport('anthropic', 'gpt-6.1-terra'), null);
  assert.equal(reasoning.reasoningSupport('deepseek', 'gpt-6.1-terra'), null);
  assert.equal(reasoning.reasoningSupport('qwen', 'gpt-6.1-terra'), null);
  assert.equal(reasoning.reasoningSupport('openai_compatible', 'grok-4.7'), null);
  assert.equal(reasoning.reasoningSupport('openai_compatible', 'gemini-3.8-flash-high'), null);
  assert.equal(reasoning.reasoningSupport('openai_compatible', 'gpt-6.1-terra-fast'), null);
  assert.ok(reasoning.reasoningRejection('openai_compatible', 'gpt-6.1-terra', 'minimal'));
  assert.equal(reasoning.reasoningRejection('openai_compatible', 'gpt-6.1-terra', 'medium'), null);
  const sql = readFileSync('migrations/020_reasoning_effort.sql', 'utf8');
  for (const id of Object.keys(reasoning.VERIFIED_REASONING_MODELS)) assert.ok(sql.includes(`'${id}'`), `迁移应包含 ${id}`);
  console.log('  ✅ 目录只覆盖已核实的 GPT 推理模型，Grok / Gemini / 未知 ID 不在内');

  {
    const db = openDb(join(dir, 'backfill.db'));
    db.exec(readFileSync('migrations/019_model_providers.sql', 'utf8'));
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO model_providers (id,name,type,base_host,created_at,updated_at) VALUES ('p_aaaaaaaa','网关','openai_compatible','gw.example.com',?,?)`).run(now, now);
    const ins = db.prepare(`INSERT INTO model_assignments (consumer,provider_id,model,strictness,follow,disabled) VALUES (?,?,?,?,?,?)`);
    ins.run('l1', 'p_aaaaaaaa', 'gpt-6.1-terra', null, null, 0);
    ins.run('l2', null, null, null, 'l1', 0);
    ins.run('embedding', 'p_aaaaaaaa', 'grok-4.7', null, null, 0);
    ins.run('sourceProfiler', 'p_aaaaaaaa', 'openai/gpt-6.1-terra', null, null, 0);
    db.exec(readFileSync('migrations/020_reasoning_effort.sql', 'utf8'));
    const effort = (c: string) => (db.prepare(`SELECT reasoning_effort FROM model_assignments WHERE consumer=?`).get(c) as any).reasoning_effort;
    assert.equal(effort('l1'), 'medium');
    assert.equal(effort('l2'), null, '跟随行不写成覆盖');
    assert.equal(effort('embedding'), null, '未核实模型保持不发送');
    assert.equal(effort('sourceProfiler'), 'medium', 'vendor/已核实 ID 也会写成 medium');
    db.close();
    console.log('  ✅ 迁移把已有的已核实显式分配写成 medium，跟随与未核实模型保持空');
  }

  const db = fresh('main.db');
  let rev = 0;
  const gateway = mp.createModelProvider(db, key, { name: '86game', type: 'openai_compatible', baseUrl: 'https://gw.example.com/v1', apiKey: KEY }, rev);
  rev = gateway.revision;
  const gem = mp.createModelProvider(db, key, { name: 'Gemini', type: 'gemini', baseUrl: '', apiKey: KEY }, rev);
  rev = gem.revision;
  rev = mp.saveAssignments(db, [
    { consumer: 'l1', mode: 'provider', providerId: gateway.id, model: 'gpt-6.1-terra', strictness: 'json' },
    { consumer: 'l2', mode: 'follow', follow: 'l1', reasoningEffort: 'high' },
    { consumer: 'l3', mode: 'follow', follow: 'l2' },
    { consumer: 'telegramSummary', mode: 'follow', follow: 'l1' },
    { consumer: 'telegramVision', mode: 'follow', follow: 'l1' },
    { consumer: 'sourceProfiler', mode: 'provider', providerId: gateway.id, model: 'gpt-6.1-terra', reasoningEffort: 'low' },
    { consumer: 'embedding', mode: 'disabled' },
  ], rev).revision;
  rev = mp.setModelConfigEnabled(db, true, rev).revision;
  assert.equal((db.prepare(`SELECT reasoning_effort FROM model_assignments WHERE consumer='l1'`).get() as any).reasoning_effort, 'medium', '显式留空会保存成 medium');
  assert.equal((db.prepare(`SELECT reasoning_effort FROM model_assignments WHERE consumer='l3'`).get() as any).reasoning_effort, null);
  const snap = mc.loadModelSnapshot(db);
  const resolved = Object.fromEntries(mc.CONSUMERS.map(c => [c, mc.resolveModel(snap, c)])) as Record<string, any>;
  assert.equal(resolved.l1.cfg.reasoningEffort, 'medium');
  assert.equal(resolved.l1.reasoningSource, 'explicit');
  assert.equal(resolved.l2.cfg.reasoningEffort, 'high');
  assert.equal(resolved.l2.reasoningSource, 'explicit');
  assert.deepEqual([resolved.l3.cfg.reasoningEffort, resolved.l3.reasoningSource, resolved.l3.reasoningFrom], ['high', 'inherited', 'l2']);
  assert.deepEqual([resolved.telegramSummary.cfg.reasoningEffort, resolved.telegramSummary.reasoningSource], ['medium', 'inherited']);
  assert.equal(resolved.telegramVision.cfg.reasoningEffort, 'medium');
  assert.equal(resolved.sourceProfiler.cfg.reasoningEffort, 'low');
  assert.deepEqual(resolved.embedding, { ok: true, disabled: true });
  assert.equal(resolved.l1.cfg.strictness, 'json', '结构化输出强度不被思考程度改写');
  assert.notEqual(resolved.l1.fingerprint, resolved.l2.fingerprint, '不同思考程度不共用缓存指纹');
  assert.equal(resolved.telegramSummary.fingerprint, resolved.l1.fingerprint);
  assert.equal(mc.fingerprintOf('p_aaaaaaaa', 1, 'flash', null), mc.fingerprintOf('p_aaaaaaaa', 1, 'flash', null, null), '未发送思考程度时指纹与原来一致');
  console.log('  ✅ 保存、默认 medium、跟随继承与单独覆盖都会进入解析结果');

  const before = (db.prepare(`SELECT reasoning_effort, model FROM model_assignments WHERE consumer='l1'`).get() as any);
  assert.throws(() => mp.saveAssignments(db, full({ consumer: 'l1', mode: 'provider', providerId: gateway.id, model: 'gpt-6.1-terra', reasoningEffort: 'minimal' }), rev), /不支持「minimal」/);
  assert.throws(() => mp.saveAssignments(db, full({ consumer: 'l1', mode: 'provider', providerId: gateway.id, model: 'grok-4.7', reasoningEffort: 'medium' }), rev), /未核实支持/);
  assert.throws(() => mp.saveAssignments(db, full({ consumer: 'l1', mode: 'provider', providerId: gateway.id, model: 'gpt-6-astra', reasoningEffort: 'none' }), rev), /不支持「none」/);
  assert.throws(() => mp.saveAssignments(db, full({ consumer: 'l1', mode: 'provider', providerId: gem.id, model: 'gemini-pro', reasoningEffort: 'medium' }), rev), /未核实支持/);
  assert.throws(() => mp.saveAssignments(db, [
    { consumer: 'l1', mode: 'provider', providerId: gateway.id, model: 'gpt-6.1-terra' },
    { consumer: 'l2', mode: 'follow', follow: 'l1' }, { consumer: 'l3', mode: 'follow', follow: 'l1' },
    { consumer: 'telegramSummary', mode: 'follow', follow: 'l1' }, { consumer: 'telegramVision', mode: 'follow', follow: 'l1' },
    { consumer: 'sourceProfiler', mode: 'disabled', reasoningEffort: 'medium' }, { consumer: 'embedding', mode: 'disabled' },
  ], rev), /不能同时保存思考程度/);
  assert.throws(() => mp.saveAssignments(db, [
    { consumer: 'l1', mode: 'provider', providerId: gateway.id, model: 'gpt-6.1-terra' },
    { consumer: 'l2', mode: 'follow', follow: 'l1' }, { consumer: 'l3', mode: 'follow', follow: 'l1' },
    { consumer: 'telegramSummary', mode: 'follow', follow: 'l1' }, { consumer: 'telegramVision', mode: 'follow', follow: 'l1' },
    { consumer: 'sourceProfiler', mode: 'disabled' },
    { consumer: 'embedding', mode: 'provider', providerId: gateway.id, model: 'text-embedding-3-small', reasoningEffort: 'medium' },
  ], rev), /向量接口不接受思考程度/);
  assert.deepEqual(db.prepare(`SELECT reasoning_effort, model FROM model_assignments WHERE consumer='l1'`).get(), before, '拒绝保存时原配置不变');
  console.log('  ✅ 不支持的显式思考程度会被拒绝，且不会改掉已保存的配置');

  const ask = async (cfg: any, extra: Record<string, unknown> = {}) => capture(() => createProvider(cfg, { retry: false }).then(p => p.complete({
    systemPrompt: 's', userContent: 'u', schema: chat, schemaName: 'ping', maxOutputTokens: 80, temperature: 0, ...extra,
  })));
  const stages = ['l1', 'l2', 'l3', 'telegramSummary', 'telegramVision', 'sourceProfiler'] as const;
  for (const c of stages) {
    const hit = await ask(resolved[c].cfg, c === 'telegramVision' ? { images: [{ mimeType: 'image/png', data: 'AQI=' }] } : {});
    assert.equal(hit.calls, 1, c);
    assert.equal(hit.body.reasoning_effort, resolved[c].cfg.reasoningEffort, c);
    assert.equal(hit.body.max_tokens, 80, c);
    assert.equal(hit.body.response_format.type, 'json_object', c);
    assert.equal('temperature' in hit.body, false, `${c} 在非 none 时不发送 temperature`);
    assert.equal('top_p' in hit.body, false, c);
    if (c === 'telegramVision') assert.equal(hit.body.messages[1].content[1].image_url.url, 'data:image/png;base64,AQI=');
  }
  const none = await ask({ provider: 'openai_compatible', model: 'gpt-6.1-terra', apiKey: KEY, baseUrl: 'https://gw.example.com/v1', reasoningEffort: 'none' });
  assert.equal(none.body.reasoning_effort, 'none');
  assert.equal(none.body.temperature, 0, 'none 时仍可发送 temperature');
  const grok = await ask({ provider: 'openai_compatible', model: 'grok-4.7', apiKey: KEY, baseUrl: 'https://gw.example.com/v1' });
  assert.equal('reasoning_effort' in grok.body, false);
  assert.equal(grok.body.temperature, 0);
  const flash = await ask({ provider: 'openai_compatible', model: 'gemini-3.8-flash-high', apiKey: KEY, baseUrl: 'https://gw.example.com/v1' });
  assert.equal('reasoning_effort' in flash.body, false);
  assert.equal(flash.body.temperature, 0, '未核实模型仍按调用方原来的 temperature 发送');
  let fetched = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { fetched++; return new Response('{}', { status: 200 }); }) as any;
  try {
    assert.throws(() => new OpenAICompatProvider({ provider: 'openai_compatible', model: 'grok-4.7', apiKey: KEY, baseUrl: 'https://gw.example.com/v1', reasoningEffort: 'medium' }), (e: any) => e instanceof ProviderError && /未核实支持/.test(e.message));
    assert.throws(() => new GeminiProvider({ provider: 'gemini', model: 'gemini-pro', apiKey: KEY, reasoningEffort: 'medium' }), (e: any) => e instanceof ProviderError);
    assert.throws(() => new AnthropicProvider({ provider: 'anthropic', model: 'claude', apiKey: KEY, reasoningEffort: 'medium' }), (e: any) => e instanceof ProviderError);
  } finally { globalThis.fetch = orig; }
  assert.equal(fetched, 0, '拒绝时没有发出请求');
  console.log('  ✅ 各聊天阶段的请求带上解析出的思考程度；Grok / Gemini 兼容名保持原样；显式不支持的设置在发请求前失败');

  const embBodies: any[] = [];
  await requestEmbeddings({
    enabled: true, baseUrl: 'https://gw.example.com/v1', model: 'gpt-6.1-terra', dimensions: 0, simHigh: 0.9, simLow: 0.8, apiKey: KEY,
  }, ['ping'], { fetchImpl: (async (_url: any, init: any) => {
    embBodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.6, 0.8] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any });
  assert.deepEqual(Object.keys(embBodies[0]).sort(), ['encoding_format', 'input', 'model']);
  console.log('  ✅ 向量请求不带 reasoning_effort');

  process.env.AI_L1_PROVIDER = 'openai_compatible';
  process.env.AI_L1_MODEL = 'gpt-6.1-terra';
  process.env.AI_L1_BASE_URL = 'https://gw.example.com/v1';
  process.env.OPENAI_COMPAT_API_KEY = KEY;
  const legacy = providerFromEnv('L1');
  assert.equal(legacy.reasoningEffort, undefined, '开关关闭的旧配置不自动加上思考程度');
  delete process.env.AI_L1_PROVIDER; delete process.env.AI_L1_MODEL; delete process.env.AI_L1_BASE_URL; delete process.env.OPENAI_COMPAT_API_KEY;
  console.log('  ✅ 旧环境变量路径不改变请求');

  const html = renderModelsSection({
    csrf: 't', enabled: true, revision: 3, keyOk: true,
    providers: [{
      id: gateway.id, name: '86game', type: 'openai_compatible', base_host: 'gw.example.com', key_ct: 'x', key_hint: '1111',
      models_json: '[]', manual_models_json: '[]', models_error_json: null, models_for: 1, config_version: 1,
      models_truncated: 0, models_fetched_at: null, baseUrl: 'https://gw.example.com/v1',
    } as any],
    assignments: [
      { consumer: 'l1', provider_id: gateway.id, model: 'gpt-6.1-terra', strictness: 'json', follow: null, disabled: 0, reasoning_effort: 'medium' },
      { consumer: 'l2', provider_id: null, model: null, strictness: null, follow: 'l1', disabled: 0, reasoning_effort: null },
      { consumer: 'embedding', provider_id: null, model: null, strictness: null, follow: null, disabled: 1, reasoning_effort: null },
    ] as any,
    status: [
      { consumer: 'l1', ok: true, text: 'OpenAI 兼容 · gw.example.com · gpt-6.1-terra · 思考程度 medium' },
      { consumer: 'l2', ok: true, text: 'OpenAI 兼容 · gw.example.com · gpt-6.1-terra · 思考程度 medium（跟随 L1）' },
    ],
  });
  assert.ok(html.includes('思考程度') && html.includes('结构化输出') && html.includes('只控制 JSON 结构'));
  const selectOf = (name: string) => html.match(new RegExp(`name="${name}">([\\s\\S]*?)</select>`))?.[1] ?? '';
  assert.ok(selectOf('l1_reasoning').includes('value="medium" selected'), selectOf('l1_reasoning'));
  assert.ok(selectOf('l2_reasoning').includes('value="" selected'), selectOf('l2_reasoning'));
  assert.ok(html.includes('思考程度 medium（跟随 L1）'));
  assert.ok(!html.includes(KEY));
  console.log('  ✅ 分配页把思考程度和结构化输出分开，默认与跟随的显示和将要发送的值一致');

  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('reasoning-effort.test.ts 通过');
