#!/usr/bin/env node
/**
 * 管理后台（PRD 16 / 14.2 / 19.2）。
 *
 * 只监听 127.0.0.1 —— 公网由 Caddy 反代并负责 TLS 与安全 Header，
 * 应用层负责会话、CSRF、限流（纵深防御，PRD 19.2）。
 *
 *   ADMIN_PASSWORD_HASH=... ADMIN_TOTP_SECRET=... node apps/web/src/server.ts
 *   未配置口令时以只读演示模式启动并明确告警。
 */
import { toggleAllnetCollection, allnetRequest, searchAllnet, subscribeAllnet, rotateAllnetToken, allnetRss, type Subscription } from '../../../packages/connectors/src/allnet.ts';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { openDb, migrate, nowIso, type DB } from '../../../packages/db/src/index.ts';
import { join } from 'node:path';
import { verifyPassword, verifyTotp, SessionStore, csrfOk, LoginLimiter, type Session }
  from '../../../packages/web/src/auth.ts';
import { renderAllnet, renderLogin, renderDashboard, renderSources, renderSettings } from '../../../packages/web/src/views.ts';
import { maskedSecrets, setSecret, setSettings, resolveSettings, vaultHealthy,
         resolveSecret, SECRET_NAMES, type SecretName } from '../../../packages/web/src/secrets.ts';
import { overrideCandidate, toggleSource, updateSourceGroup, updateSourceUrl, planResend, addSource, deleteSource,
         testSource, approveSourceProposal, rejectSourceProposal, ensureProfilerProfile, ActionError } from '../../../packages/web/src/actions.ts';
import { createProvider } from '../../../packages/ai/src/registry.ts';
import { runSourceProfiler } from '../../../packages/ai/src/source-profiler.ts';
import { readyTelegramDb } from '../../../packages/telegram/src/db.ts';
import { addTelegramSource, retryTelegramSource, rotateAllToken, rotateSourceToken,
         toggleTelegramSource, updateTelegramSettings, TelegramError } from '../../../packages/telegram/src/core.ts';
import { sourceRss, allRss } from '../../../packages/telegram/src/rss.ts';
import { sendLoginCommand, type LoginCommand } from '../../../packages/telegram/src/login.ts';
import { renderTelegram } from '../../../packages/telegram/src/views.ts';

const PORT = Number(process.env.ADMIN_PORT ?? 3000);
const HOST = process.env.ADMIN_HOST ?? '127.0.0.1';
const PW_HASH = process.env.ADMIN_PASSWORD_HASH ?? '';
const TOTP = process.env.ADMIN_TOTP_SECRET ?? '';
const SECURE_COOKIE = (process.env.ADMIN_SECURE_COOKIE ?? 'true') !== 'false';

const db: DB = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
const telegramDb = readyTelegramDb();
// 新部署可以直接启动：首次启动自动应用前向迁移，重复启动保持幂等。
migrate(db, join(process.cwd(), 'migrations'));
const sessions = new SessionStore(Number(process.env.ADMIN_SESSION_HOURS ?? 12));
const limiter = new LoginLimiter(5, 15 * 60e3);
setInterval(() => sessions.sweep(), 10 * 60e3).unref();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info', serializers: { req(req) { return { method:req.method, url:String(req.url).startsWith('/rss/') ? '/rss/[REDACTED]' : req.url }; } } },
  bodyLimit: 256 * 1024,
  trustProxy: true,          // Caddy 在前，需要真实客户端 IP 做限流
});
await app.register(cookie);
// HTML 表单提交的是 application/x-www-form-urlencoded，
// Fastify 默认只解析 JSON —— 少了这个插件浏览器登录会直接 415。
await app.register(formbody, { bodyLimit: 64 * 1024 });

const configured = !!PW_HASH;
if (!configured)
  app.log.warn('未设置 ADMIN_PASSWORD_HASH —— 以只读演示模式启动，所有写操作被拒绝');

// ---------- 会话 ----------
const sessionOf = (req: any): Session | null => sessions.get(req.cookies?.sid);

app.addHook('onRequest', async (req, reply) => {
  // 后台不应被搜索引擎或嵌入
  reply.header('X-Robots-Tag', 'noindex, nofollow');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Cache-Control', 'no-store');
  reply.header('Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
});

/** 未登录一律跳登录页；API 返回 401。 */
function requireAuth(req: any, reply: any): Session | null {
  const s = sessionOf(req);
  if (s) return s;
  if (req.url.startsWith('/api/')) { reply.code(401).send({ error: '未登录' }); return null; }
  reply.redirect('/login');
  return null;
}

/**
 * 写操作前置：演示模式一律拒绝 + CSRF + 同源。
 * 顺序重要 —— 未配置口令时连 CSRF 都不该走到。
 */
function requireWrite(req: any, reply: any, s: Session): boolean {
  if (!configured) {
    reply.code(403).send({ error: '只读演示模式：未设置 ADMIN_PASSWORD_HASH，写操作被禁用' });
    return false;
  }
  return requireCsrf(req, reply, s);
}

/** 写操作必须带正确的 CSRF token 且为同源（PRD 14.2）。 */
function requireCsrf(req: any, reply: any, s: Session): boolean {
  const token = (req.body as any)?.csrf ?? req.headers['x-csrf-token'];
  if (!csrfOk(s, token)) { reply.code(403).send({ error: 'CSRF 校验失败' }); return false; }
  const origin = req.headers.origin;
  if (origin) {
    const expect = process.env.ADMIN_BASE_URL;
    if (expect && !origin.startsWith(expect)) {
      reply.code(403).send({ error: '跨源请求被拒绝' }); return false;
    }
  }
  return true;
}

// ---------- 登录 ----------
app.get('/login', async (req, reply) => {
  if (sessionOf(req)) return reply.redirect('/');
  return reply.type('text/html; charset=utf-8')
    .send(renderLogin({ configured, needTotp: !!TOTP }));
});

app.post('/login', async (req, reply) => {
  const ip = req.ip ?? 'unknown';
  const gate = limiter.check(ip);
  if (!gate.allowed) {
    return reply.code(429).type('text/html; charset=utf-8')
      .send(renderLogin({ configured, needTotp: !!TOTP,
        error: `尝试过于频繁，请 ${Math.ceil(gate.retryAfterSec / 60)} 分钟后再试` }));
  }
  const { password = '', totp = '' } = (req.body ?? {}) as any;

  // 未配置时不允许任何人登录 —— 演示模式只读
  const pwOk = configured && verifyPassword(String(password), PW_HASH);
  const totpOk = !TOTP || verifyTotp(TOTP, String(totp));

  if (!pwOk || !totpOk) {
    limiter.fail(ip);
    req.log.warn({ ip: 'redacted', pwOk, totpOk }, '登录失败');
    // 不区分「口令错」与「验证码错」，避免泄露哪一项正确
    return reply.code(401).type('text/html; charset=utf-8')
      .send(renderLogin({ configured, needTotp: !!TOTP, error: '口令或验证码错误' }));
  }

  limiter.reset(ip);
  const s = sessions.create();
  reply.setCookie('sid', s.id, {
    httpOnly: true, sameSite: 'strict', secure: SECURE_COOKIE, path: '/',
    maxAge: Number(process.env.ADMIN_SESSION_HOURS ?? 12) * 3600,
  });
  return reply.redirect('/');
});

app.post('/logout', async (req, reply) => {
  const s = sessionOf(req);
  if (s && !requireCsrf(req, reply, s)) return;
  sessions.destroy(req.cookies?.sid);
  reply.clearCookie('sid', { path: '/' });
  return reply.redirect('/login');
});

// ---------- 健康检查（不需要登录，供部署流程用） ----------
app.get('/health/live', async () => ({ ok: true }));
app.get('/health/ready', async (_req, reply) => {
  try {
    db.prepare('SELECT 1').get();
    telegramDb.prepare('SELECT 1').get();
    return { ok: true, sessions: sessions.size };
  } catch (e: any) {
    return reply.code(503).send({ ok: false, error: String(e?.message ?? e) });
  }
});

// ---------- 页面 ----------
const q = {
  sources: () => db.prepare(`SELECT id,display_name,category,source_group,health,harvest_tier,
    consecutive_failures,last_success_at,last_http_code,last_error,latest_item_at,enabled,managed_by,onboarding_status,observation_until,
    (SELECT json_object('upstream_id',upstream_id,'item_limit',item_limit,'kind',kind,'token',token,'snapshot_at',snapshot_at,'collection_enabled',collection_enabled) FROM allnet_subscriptions a WHERE a.source_id=sources.id) allnet_json,
    (SELECT url FROM source_endpoints e WHERE e.source_id=sources.id AND e.priority=1) endpoint_url,
    (SELECT parser FROM source_endpoints e WHERE e.source_id=sources.id AND e.priority=1) endpoint_parser
    FROM sources ORDER BY CASE health WHEN 'failing' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, id`).all(),
  tests: () => db.prepare(`SELECT url,outcome,parsed_count,error,started_at
    FROM source_tests ORDER BY id DESC LIMIT 8`).all(),
  proposals: () => db.prepare(`SELECT p.*, s.onboarding_status FROM source_onboarding_proposals p
    LEFT JOIN sources s ON s.id=p.source_id ORDER BY p.id DESC LIMIT 20`).all(),
  harvests: () => db.prepare(`SELECT * FROM harvest_runs ORDER BY id DESC LIMIT 12`).all(),
  runs: () => db.prepare(`SELECT r.*, (SELECT count(*) FROM candidates c WHERE c.run_id=r.id) cands
    FROM runs r ORDER BY r.id DESC LIMIT 30`).all(),
  candidates: (id: number) => db.prepare(`SELECT c.*, f.source_id, v.title, f.canonical_url
    FROM candidates c JOIN item_versions v ON v.id=c.item_version_id
    JOIN feed_items f ON f.id=v.item_id WHERE c.run_id=? ORDER BY c.decision, c.id`).all(id),
  stats: () => ({
    items: (db.prepare('SELECT count(*) c FROM feed_items').get() as any).c,
    versions: (db.prepare('SELECT count(*) c FROM item_versions').get() as any).c,
    candidates: (db.prepare('SELECT count(*) c FROM candidates').get() as any).c,
    deliveries: db.prepare(`SELECT status, count(*) c FROM deliveries GROUP BY 1`).all(),
    pendingFulltext: (db.prepare(`SELECT count(*) c FROM item_versions v
      JOIN feed_items f ON f.id=v.item_id JOIN sources s ON s.id=f.source_id
      WHERE s.require_fulltext=1 AND v.fulltext_status IS NULL`).get() as any).c,
    onboardingPending: (db.prepare(`SELECT count(*) c FROM source_onboarding_proposals WHERE status IN ('HUMAN_REVIEW','AI_ANALYZED','AI_ANALYSIS_FAILED')`).get() as any).c,
    profilerCalls: (db.prepare(`SELECT count(*) c FROM audit_events WHERE action='source_profiled'`).get() as any).c,
    aiTokens: (db.prepare(`SELECT coalesce(sum(input_tokens+output_tokens),0) n FROM usage_ledger`).get() as any).n,
    aiCostUsd: (db.prepare(`SELECT coalesce(sum(cost_usd),0) n FROM usage_ledger`).get() as any).n,
  }),
};

app.get('/', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  return reply.type('text/html; charset=utf-8').send(renderDashboard({
    csrf: s.csrf, sources: q.sources() as any, harvests: q.harvests() as any,
    stats: q.stats() as any,
  }));
});

const telegramPage = (s: Session, extra: Record<string,unknown> = {}) => renderTelegram({
  csrf: s.csrf,
  sources: telegramDb.prepare('SELECT * FROM telegram_sources ORDER BY id DESC').all() as any[],
  settings: telegramDb.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get() as any,
  worker: telegramDb.prepare('SELECT * FROM telegram_worker_state WHERE singleton=1').get() as any,
  baseUrl: process.env.ADMIN_BASE_URL ?? '', ...extra,
});

app.get('/telegram', async (req, reply) => {
  const s=requireAuth(req,reply); if(!s)return;
  return reply.type('text/html; charset=utf-8').send(telegramPage(s));
});

app.post('/telegram/sources', async (req, reply) => {
  const s=requireAuth(req,reply); if(!s||!requireWrite(req,reply,s))return;
  const b=(req.body??{}) as any;
  try { const r=addTelegramSource(telegramDb,{reference:String(b.reference??''),displayName:String(b.display_name??''),sourceType:String(b.source_type??'normal') as any});
    return reply.type('text/html; charset=utf-8').send(telegramPage(s,{saved:`来源 #${r.id} 已进入异步验证队列。`})); }
  catch(e:any){return reply.code(e instanceof TelegramError?e.code:500).type('text/html; charset=utf-8').send(telegramPage(s,{error:e instanceof TelegramError?e.message:'新增来源失败'}));}
});

app.post<{Params:{id:string}}>('/telegram/sources/:id/retry', async(req,reply)=>{
  const s=requireAuth(req,reply);if(!s||!requireWrite(req,reply,s))return;
  try{retryTelegramSource(telegramDb,Number(req.params.id));return reply.redirect('/telegram');}
  catch(e:any){return reply.code(e instanceof TelegramError?e.code:500).send({error:e instanceof TelegramError?e.message:'重试失败'});}
});
app.post<{Params:{id:string}}>('/telegram/sources/:id/toggle',async(req,reply)=>{
  const s=requireAuth(req,reply);if(!s||!requireWrite(req,reply,s))return;
  try{toggleTelegramSource(telegramDb,Number(req.params.id),String((req.body as any)?.enabled)==='true');return reply.redirect('/telegram');}
  catch(e:any){return reply.code(e instanceof TelegramError?e.code:500).send({error:e instanceof TelegramError?e.message:'启停失败'});}
});
app.post<{Params:{id:string}}>('/telegram/sources/:id/token',async(req,reply)=>{
  const s=requireAuth(req,reply);if(!s||!requireWrite(req,reply,s))return;
  try{rotateSourceToken(telegramDb,Number(req.params.id),(req.body as any)?.action==='revoke');return reply.redirect('/telegram');}
  catch(e:any){return reply.code(e instanceof TelegramError?e.code:500).send({error:e instanceof TelegramError?e.message:'令牌操作失败'});}
});
app.post('/telegram/rss/all/token',async(req,reply)=>{
  const s=requireAuth(req,reply);if(!s||!requireWrite(req,reply,s))return;
  rotateAllToken(telegramDb,(req.body as any)?.action==='revoke');return reply.redirect('/telegram');
});
app.post('/telegram/settings',async(req,reply)=>{
  const s=requireAuth(req,reply);if(!s||!requireWrite(req,reply,s))return; const b=(req.body??{}) as any;
  try{updateTelegramSettings(telegramDb,{timezone:b.timezone,schedule:b.schedule,provider:b.provider,model:b.model,baseUrl:b.base_url,credentialRef:b.credential_ref,promptRules:b.prompt_rules});return reply.type('text/html; charset=utf-8').send(telegramPage(s,{saved:'Telegram 设置已保存；已完成的历史总结不会重写。'}));}
  catch(e:any){return reply.code(e instanceof TelegramError?e.code:500).type('text/html; charset=utf-8').send(telegramPage(s,{error:e instanceof TelegramError?e.message:'设置保存失败'}));}
});
for(const command of ['start','code','password'] as LoginCommand[]) app.post(`/telegram/login/${command}`,async(req,reply)=>{
  const s=requireAuth(req,reply);if(!s||!requireWrite(req,reply,s))return;
  try{const result=await sendLoginCommand(command,String((req.body as any)?.value??''));return reply.type('text/html; charset=utf-8').send(telegramPage(s,result.ok?{saved:`登录状态：${result.state??'已更新'}`}:{error:result.error??'登录失败'}));}
  catch{return reply.code(503).type('text/html; charset=utf-8').send(telegramPage(s,{error:'Telegram worker 未运行或登录 Socket 不可用'}));}
});

app.get<{Params:{token:string}}>('/rss/telegram/source/:token',async(req,reply)=>{
  if(!/^[a-f0-9]{64}$/.test(req.params.token))return reply.code(404).send('订阅不存在');
  const body=sourceRss(telegramDb,req.params.token,process.env.ADMIN_BASE_URL??'');
  if(body===null)return reply.code(404).send('订阅不存在');
  return reply.header('Cache-Control','private, no-store, max-age=0').header('Referrer-Policy','no-referrer').type('application/rss+xml; charset=utf-8').send(body);
});
app.get<{Params:{token:string}}>('/rss/telegram/all/:token',async(req,reply)=>{
  if(!/^[a-f0-9]{64}$/.test(req.params.token))return reply.code(404).send('订阅不存在');
  const body=allRss(telegramDb,req.params.token,process.env.ADMIN_BASE_URL??'');
  if(body===null)return reply.code(404).send('订阅不存在');
  return reply.header('Cache-Control','private, no-store, max-age=0').header('Referrer-Policy','no-referrer').type('application/rss+xml; charset=utf-8').send(body);
});

const sourcesPage = (s: Session, extra: Record<string, unknown> = {}) =>
  renderSources({ csrf: s.csrf, sources: q.sources() as any, tests: q.tests() as any,
    proposals: q.proposals() as any, baseUrl: process.env.ADMIN_BASE_URL ?? '', ...extra });

const allnetPage = (s:Session, extra:Record<string,unknown>={}) => renderAllnet({
  csrf:s.csrf,sources:q.sources() as any,baseUrl:process.env.ADMIN_BASE_URL??'',...extra,
});
app.get('/allnet',async(req,reply)=>{
  const session=requireAuth(req,reply);if(!session)return;
  return reply.type('text/html; charset=utf-8').send(allnetPage(session));
});
app.post<{Params:{id:string}}>('/allnet/:id/toggle',async(req,reply)=>{
  const session=requireAuth(req,reply);if(!session||!requireWrite(req,reply,session))return;
  const enabled=(req.body as any)?.enabled;
  if(!['true','false'].includes(enabled))return reply.code(400).send({error:'无效启停状态'});
  try {toggleAllnetCollection(db,req.params.id,enabled==='true');return reply.redirect('/allnet');}
  catch(e:any){return reply.code(e.status??500).send({error:e.message});}
});

app.get('/sources', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  return reply.type('text/html; charset=utf-8').send(sourcesPage(s));
});


app.get<{Params:{token:string}}>('/rss/allnet/:token', async(req,reply)=>{
  if(!/^[a-f0-9]{64}$/.test(req.params.token)) return reply.code(404).send('订阅不存在');
  const row=db.prepare(`SELECT a.*,s.display_name,s.last_error FROM allnet_subscriptions a JOIN sources s ON s.id=a.source_id WHERE a.token=?`).get(req.params.token) as (Subscription & {display_name:string;last_error:string})|undefined;
  if(!row) return reply.code(404).send('订阅不存在');
  if(!row.snapshot_at) return reply.code(503).send('尚无成功快照');
  return reply.header('Referrer-Policy','no-referrer').type('application/rss+xml; charset=utf-8').send(allnetRss(row,row.display_name,row.last_error));
});
for(const path of ['/allnet/search','/sources/allnet/search']) app.post(path,async(req,reply)=>{
  const session=requireAuth(req,reply);if(!session||!requireWrite(req,reply,session))return;
  const name=String((req.body as any)?.name??'').trim();
  try {
    const rows=await searchAllnet(db,name);const exact=rows.filter(r=>r.title===name);
    if(exact.length===1) {const id=await subscribeAllnet(db,exact[0]!.id,exact[0]!.title,String((req.body as any)?.origin??''));return reply.type('text/html').send(allnetPage(session,{saved:`已订阅：${id}`}));}
    return reply.type('text/html').send(allnetPage(session,{allnetCandidates:rows,allnetQuery:name,...(!rows.length?{error:'未找到匹配来源；百度热搜暂不可用'}:{})}));
  } catch(e:any) {return reply.code(e.status??502).type('text/html').send(allnetPage(session,{error:e.message}));}
});
for(const path of ['/allnet/add','/sources/allnet/add']) app.post(path,async(req,reply)=>{
  const session=requireAuth(req,reply);if(!session||!requireWrite(req,reply,session))return;
  try {
    const b=req.body as any;const rows=await searchAllnet(db,String(b.name??''));const match=rows.find(r=>r.id===Number(b.upstream_id));
    if(!match) return reply.code(400).send('来源不在搜索候选中');
    const id=await subscribeAllnet(db,match.id,match.title,String(b.origin??''));
    return reply.type('text/html').send(allnetPage(session,{saved:`已订阅：${id}`}));
  } catch(e:any) {return reply.code(e.status??502).type('text/html').send(allnetPage(session,{error:e.message}));}
});
for(const path of ['/allnet/:id/token','/sources/:id/allnet/token']) app.post<{Params:{id:string}}>(path,async(req,reply)=>{
  const session=requireAuth(req,reply);if(!session||!requireWrite(req,reply,session))return;
  try {rotateAllnetToken(db,req.params.id,(req.body as any)?.action==='revoke');return reply.redirect('/allnet');}
  catch(e:any) {return reply.code(e.status??502).send({error:e.message});}
});
app.post('/settings/allnet/test',async(req,reply)=>{
  const session=requireAuth(req,reply);if(!session||!requireWrite(req,reply,session))return;
  try {await allnetRequest(db,'/sources',{page:'1'},true);return reply.type('text/html').send(settingsPage(session,{saved:'全网热点连通性测试通过'}));}
  catch(e:any) {return reply.code(e.status??502).type('text/html').send(settingsPage(session,{error:e.message}));}
});

/** 仅测试，不添加（FR-004：不写入正式简报，但保存诊断日志） */
app.post('/sources/test', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  const t = await testSource(db, { url: String(b.url ?? ''), parser: String(b.parser ?? 'rss') });
  const msg = t.ok
    ? `测试通过：解析出 ${t.parsedCount} 条，耗时 ${t.latencyMs}ms。` +
      (t.sample.length ? ` 首条「${t.sample[0]!.title.slice(0, 40)}」` : '')
    : undefined;
  return reply.type('text/html; charset=utf-8')
    .send(sourcesPage(s, t.ok ? { saved: msg } : { error: `测试失败（${t.outcome}）：${t.error}` }));
});

app.post('/sources/add', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  try {
    const r = await addSource(db, {
      id: String(b.id ?? ''), name: String(b.name ?? ''), url: String(b.url ?? ''),
      parser: String(b.parser ?? 'rss'), category: String(b.category ?? 'tech'),
      sourceGroup: String(b.source_group ?? 'unclassified'),
      tier: String(b.tier ?? 'standard'), priority: Number(b.priority ?? 5),
      requireFulltext: !!b.require_fulltext, actor: 'owner',
      skipTest: String(b.skip_test ?? '') === '1',
    });
    return reply.type('text/html; charset=utf-8')
      .send(sourcesPage(s, { saved: `来源「${r.id}」已完成探测，提案 #${r.proposalId} 已进入人工审核；审批前不会采集或进入日报。` }));
  } catch (e) {
    const msg = e instanceof ActionError ? e.message : '内部错误';
    if (!(e instanceof ActionError)) req.log.error({ err: e }, '新增来源失败');
    return reply.code(e instanceof ActionError ? e.code : 500)
      .type('text/html; charset=utf-8').send(sourcesPage(s, { error: msg, form: b }));
  }
});

app.post<{ Params: { id: string } }>('/sources/proposals/:id/approve', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  try { const r = approveSourceProposal(db, Number(req.params.id), 'owner'); return reply.type('text/html; charset=utf-8').send(sourcesPage(s, { saved: `提案已批准，来源进入三窗口观察期（${r.sourceId}）。` })); }
  catch (e) { const msg = e instanceof ActionError ? e.message : '内部错误'; return reply.code(e instanceof ActionError ? e.code : 500).type('text/html; charset=utf-8').send(sourcesPage(s, { error: msg })); }
});

app.post<{ Params: { id: string } }>('/sources/proposals/:id/reject', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  try { rejectSourceProposal(db, Number(req.params.id), String(b.reason ?? ''), 'owner'); return reply.type('text/html; charset=utf-8').send(sourcesPage(s, { saved: '提案已拒绝，来源保持停用。' })); }
  catch (e) { const msg = e instanceof ActionError ? e.message : '内部错误'; return reply.code(e instanceof ActionError ? e.code : 500).type('text/html; charset=utf-8').send(sourcesPage(s, { error: msg })); }
});

app.post<{ Params: { id: string } }>('/sources/:id/delete', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  try {
    const r = deleteSource(db, req.params.id, String(b.reason ?? ''), 'owner');
    return reply.type('text/html; charset=utf-8').send(sourcesPage(s, {
      saved: `来源已删除并停用。已抓取的 ${r.retainedItems} 条内容按审计要求保留。` }));
  } catch (e) {
    const msg = e instanceof ActionError ? e.message : '内部错误';
    return reply.code(e instanceof ActionError ? e.code : 500)
      .type('text/html; charset=utf-8').send(sourcesPage(s, { error: msg }));
  }
});

app.post<{ Params: { id: string } }>('/sources/:id/url', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  try {
    const r = await updateSourceUrl(db, { sourceId: req.params.id,
      url: String(b.url ?? ''), reason: String(b.reason ?? ''), actor: 'owner' });
    return reply.type('text/html; charset=utf-8').send(sourcesPage(s, {
      saved: `来源「${r.sourceId}」的订阅 URL 已更新；测试解析出 ${r.parsedCount} 条。` }));
  } catch (e) {
    const msg = e instanceof ActionError ? e.message : '内部错误';
    if (!(e instanceof ActionError)) req.log.error({ err: e }, '修改来源 URL 失败');
    return reply.code(e instanceof ActionError ? e.code : 500)
      .type('text/html; charset=utf-8').send(sourcesPage(s, { error: msg }));
  }
});

app.post<{ Params: { id: string } }>('/sources/:id/group', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  try {
    updateSourceGroup(db, req.params.id, String(b.source_group ?? ''), String(b.reason ?? ''), 'owner');
    return reply.type('text/html; charset=utf-8').send(sourcesPage(s, { saved: '来源分组已更新。' }));
  } catch (e) {
    const msg = e instanceof ActionError ? e.message : '内部错误';
    return reply.code(e instanceof ActionError ? e.code : 500)
      .type('text/html; charset=utf-8').send(sourcesPage(s, { error: msg }));
  }
});

// ---------- 只读 API ----------
app.get('/api/v1/dashboard', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return { sources: q.sources(), harvests: q.harvests(), runs: q.runs(), stats: q.stats() };
});
app.get('/api/v1/sources', async (req, reply) => {
  if (!requireAuth(req, reply)) return; return q.sources();
});
/** 后台自动化新增来源：与网页表单共用校验、测试抓取和审计。 */
app.post('/api/v1/sources', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  try {
    const r = await addSource(db, {
      id: String(b.id ?? ''), name: String(b.name ?? ''), url: String(b.url ?? ''),
      parser: String(b.parser ?? 'rss'), category: String(b.category ?? 'tech'),
      sourceGroup: String(b.source_group ?? 'unclassified'),
      tier: String(b.tier ?? 'standard'), priority: Number(b.priority ?? 5),
      requireFulltext: !!b.require_fulltext, mandatoryRetention: !!b.mandatory_retention,
      actor: 'owner', skipTest: b.skip_test === true || String(b.skip_test ?? '') === '1',
    });
    return reply.code(201).send(r);
  } catch (e) {
    const msg = e instanceof ActionError ? e.message : '内部错误';
    if (!(e instanceof ActionError)) req.log.error({ err: e }, 'API 新增来源失败');
    return reply.code(e instanceof ActionError ? e.code : 500).send({ error: msg });
  }
});
app.post<{ Params: { id: string } }>('/api/v1/sources/:id/url', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  try { return await updateSourceUrl(db, { sourceId: req.params.id,
    url: String(b.url ?? ''), reason: String(b.reason ?? ''), actor: 'owner' }); }
  catch (e) { const msg = e instanceof ActionError ? e.message : '内部错误';
    return reply.code(e instanceof ActionError ? e.code : 500).send({ error: msg }); }
});
app.post<{ Params: { id: string } }>('/api/v1/sources/:id/group', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  try { return updateSourceGroup(db, req.params.id, String((req.body as any)?.source_group ?? ''),
    String((req.body as any)?.reason ?? ''), 'owner'); }
  catch (e) { const msg = e instanceof ActionError ? e.message : '内部错误';
    return reply.code(e instanceof ActionError ? e.code : 500).send({ error: msg }); }
});
app.post<{ Params: { id: string } }>('/api/v1/source-proposals/:id/approve', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  try { return approveSourceProposal(db, Number(req.params.id), 'owner'); }
  catch (e) { const msg = e instanceof ActionError ? e.message : '内部错误'; return reply.code(e instanceof ActionError ? e.code : 500).send({ error: msg }); }
});
app.post<{ Params: { id: string } }>('/api/v1/source-proposals/:id/reject', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  try { return rejectSourceProposal(db, Number(req.params.id), String((req.body as any)?.reason ?? ''), 'owner'); }
  catch (e) { const msg = e instanceof ActionError ? e.message : '内部错误'; return reply.code(e instanceof ActionError ? e.code : 500).send({ error: msg }); }
});
app.get('/api/v1/runs', async (req, reply) => {
  if (!requireAuth(req, reply)) return; return q.runs();
});
app.get<{ Params: { id: string } }>('/api/v1/runs/:id/candidates', async (req, reply) => {
  if (!requireAuth(req, reply)) return; return q.candidates(Number(req.params.id));
});

// ---------- 写操作（PRD 16.4 / 16.5 / 19.2：全部留痕） ----------

/** 把 ActionError 映射为 HTTP 响应，其余错误交给全局处理器。 */
function handleAction(reply: any, fn: () => unknown) {
  try { return { ok: true, result: fn() }; }
  catch (e) {
    if (e instanceof ActionError) { reply.code(e.code).send({ error: e.message }); return null; }
    throw e;
  }
}

app.post<{ Params: { id: string } }>('/candidates/:id/override', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  const r = handleAction(reply, () => overrideCandidate(db, {
    candidateId: Number(req.params.id),
    action: b.action, reason: b.reason, scope: b.scope,
    mandatoryClass: b.mandatory_class ?? null, section: b.section ?? null,
    actor: 'owner',
  }));
  if (!r) return;
  return b.redirect ? reply.redirect(String(b.redirect)) : r.result;
});

app.post<{ Params: { id: string } }>('/sources/:id/toggle', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  const r = handleAction(reply, () =>
    toggleSource(db, req.params.id, String(b.enabled) === 'true', b.reason, 'owner'));
  if (!r) return;
  return b.redirect ? reply.redirect(String(b.redirect)) : r.result;
});

/** 补发第一步：只返回确认信息，不发送（PRD 16.5 两步确认）。 */
app.get<{ Params: { id: string }; Querystring: { to?: string } }>(
  '/api/v1/briefs/:id/resend-plan', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  const to = req.query.to ?? process.env.MAIL_TO ?? '';
  if (!to) return reply.code(400).send({ error: '缺少收件人' });
  const r = handleAction(reply, () => planResend(db, Number(req.params.id), to));
  return r ? r.result : undefined;
});

// ---------- 设置（AI 供应商与 API Key） ----------
const envOverrides = () => {
  const names = ['AI_PROVIDER','AI_L1_PROVIDER','AI_L1_MODEL','AI_L2_MODEL','AI_L3_MODEL',
                 'AI_L2_PROVIDER','AI_L3_PROVIDER','AI_L1_BASE_URL','AI_L2_BASE_URL',
                 'AI_L3_BASE_URL', ...SECRET_NAMES];
  return names.filter(n => !!process.env[n]);
};

function settingsPage(s: Session, extra: { saved?: string; error?: string } = {}) {
  const h = vaultHealthy();
  return renderSettings({
    csrf: s.csrf, vaultOk: h.ok, vaultReason: h.reason,
    secrets: maskedSecrets(), settings: resolveSettings() as any,
    envOverrides: envOverrides(), ...extra,
  });
}

app.get('/settings', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  return reply.type('text/html; charset=utf-8').send(settingsPage(s));
});

app.post('/settings/ai', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  try {
    setSettings({
      aiProvider: String(b.ai_provider ?? '').trim(),
      l1Provider: String(b.l1_provider ?? '').trim(),
      l1Model: String(b.l1_model ?? '').trim(),
      l2Model: String(b.l2_model ?? '').trim(),
      l3Model: String(b.l3_model ?? '').trim(),
      l2Provider: String(b.l2_provider ?? '').trim(),
      l3Provider: String(b.l3_provider ?? '').trim(),
      l1BaseUrl: String(b.l1_base_url ?? '').trim(),
      l2BaseUrl: String(b.l2_base_url ?? '').trim(),
      l3BaseUrl: String(b.l3_base_url ?? '').trim(),
    });
    db.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at)
      VALUES ('settings','ai','ai_settings_updated',?,?)`)
      .run(JSON.stringify({ l1Provider: b.l1_provider, l1Model: b.l1_model, l1BaseUrl: b.l1_base_url || 'default',
        l2Provider: b.l2_provider || 'same-as-l1', l2BaseUrl: b.l2_base_url || 'default',
        l3Provider: b.l3_provider || 'same-as-l1', l3BaseUrl: b.l3_base_url || 'default', actor: 'owner' }), nowIso());
    return reply.type('text/html; charset=utf-8').send(settingsPage(s, { saved: '供应商设置已保存。worker 下次运行即生效。' }));
  } catch (e: any) {
    return reply.code(500).type('text/html; charset=utf-8').send(settingsPage(s, { error: String(e?.message ?? e) }));
  }
});

app.post('/settings/source-profiler', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  try {
    const providerName = String(b.provider ?? 'mock').trim() as any;
    const credentialRef = String(b.credential_ref ?? 'SOURCE_PROFILER_API_KEY').trim();
    const probeProvider = await createProvider({ provider: providerName, model: String(b.model ?? '').trim() || 'mock-profiler',
      baseUrl: String(b.base_url ?? '').trim() || undefined, timeoutMs: Number(b.timeout_ms ?? 30000),
      apiKey: providerName === 'mock' ? undefined : resolveSecret(credentialRef as any) });
    await runSourceProfiler(probeProvider, { url: 'https://example.com/feed.xml', parser: 'rss', name: 'structured-output-test',
      metadata: { test: true }, samples: [{ sampleId: 'test-1', title: 'structured output test', link: 'https://example.com/1', publishedRaw: null }] });
    setSettings({ sourceProfilerProvider: String(b.provider ?? '').trim(), sourceProfilerModel: String(b.model ?? '').trim(),
      sourceProfilerBaseUrl: String(b.base_url ?? '').trim(), sourceProfilerCredentialRef: String(b.credential_ref ?? 'SOURCE_PROFILER_API_KEY').trim(),
      sourceProfilerTemperature: String(b.temperature ?? '0.1').trim(), sourceProfilerReasoningEffort: String(b.reasoning_effort ?? '').trim(),
      sourceProfilerMaxInputChars: String(b.max_input_chars ?? '24000').trim(), sourceProfilerMaxOutputTokens: String(b.max_output_tokens ?? '1800').trim(),
      sourceProfilerTimeoutMs: String(b.timeout_ms ?? '30000').trim(), sourceProfilerRetryPolicy: String(b.retry_policy ?? '1').trim(),
      sourceProfilerFallbackProfile: String(b.fallback_profile ?? '').trim(), sourceProfilerEnabled: String(b.enabled ?? 'true') });
    const profile = ensureProfilerProfile(db);
    db.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at) VALUES ('settings','source_profiler','source_profiler_settings_updated',?,?)`)
      .run(JSON.stringify({ provider: b.provider, model: b.model, enabled: b.enabled, config_version: profile.config_version, actor: 'owner' }), nowIso());
    return reply.type('text/html; charset=utf-8').send(settingsPage(s, { saved: `Source Profiler 配置已保存并生成版本 v${profile.config_version}；下一次新增来源时会使用。` }));
  } catch (e: any) { return reply.code(500).type('text/html; charset=utf-8').send(settingsPage(s, { error: String(e?.message ?? e) })); }
});

app.post('/settings/secret', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  const name = String(b.name ?? '') as SecretName;
  if (!SECRET_NAMES.includes(name))
    return reply.code(400).type('text/html; charset=utf-8').send(settingsPage(s, { error: '未知的密钥名' }));
  try {
    const val = String(b.value ?? '');
    setSecret(name, val);
    // 审计只记「哪个 key 被改了」，绝不记值本身（PRD 19.2）
    db.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at)
      VALUES ('secret',?,?,?,?)`)
      .run(name, val.trim() ? 'secret_set' : 'secret_cleared',
           JSON.stringify({ actor: 'owner', length: val.trim().length }), nowIso());
    return reply.type('text/html; charset=utf-8')
      .send(settingsPage(s, { saved: `${name} 已${val.trim() ? '保存' : '清除'}。worker 下次运行即生效。` }));
  } catch (e: any) {
    return reply.code(500).type('text/html; charset=utf-8').send(settingsPage(s, { error: String(e?.message ?? e) }));
  }
});

app.setErrorHandler((err, req, reply) => {
  // 敏感错误只进服务器日志，前端不暴露堆栈（PRD 14.2）
  req.log.error({ err }, '请求处理失败');
  reply.code((err as any).statusCode ?? 500).send({ error: '服务器内部错误', request_id: req.id });
});

await app.listen({ port: PORT, host: HOST });
app.log.info(`管理后台已启动 http://${HOST}:${PORT}（仅本机，公网经 Caddy 反代）`);
