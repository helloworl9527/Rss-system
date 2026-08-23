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
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { openDb, nowIso, type DB } from '../../../packages/db/src/index.ts';
import { verifyPassword, verifyTotp, SessionStore, csrfOk, LoginLimiter, type Session }
  from '../../../packages/web/src/auth.ts';
import { renderLogin, renderDashboard, renderSources, renderRuns, renderRunDetail,
         renderAudit, renderSettings, layout } from '../../../packages/web/src/views.ts';
import { maskedSecrets, setSecret, setSettings, resolveSettings, vaultHealthy,
         SECRET_NAMES, type SecretName } from '../../../packages/web/src/secrets.ts';
import { overrideCandidate, toggleSource, planResend, ActionError }
  from '../../../packages/web/src/actions.ts';

const PORT = Number(process.env.ADMIN_PORT ?? 3000);
const HOST = process.env.ADMIN_HOST ?? '127.0.0.1';
const PW_HASH = process.env.ADMIN_PASSWORD_HASH ?? '';
const TOTP = process.env.ADMIN_TOTP_SECRET ?? '';
const SECURE_COOKIE = (process.env.ADMIN_SECURE_COOKIE ?? 'true') !== 'false';

const db: DB = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
const sessions = new SessionStore(Number(process.env.ADMIN_SESSION_HOURS ?? 12));
const limiter = new LoginLimiter(5, 15 * 60e3);
setInterval(() => sessions.sweep(), 10 * 60e3).unref();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
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
    return { ok: true, sessions: sessions.size };
  } catch (e: any) {
    return reply.code(503).send({ ok: false, error: String(e?.message ?? e) });
  }
});

// ---------- 页面 ----------
const q = {
  sources: () => db.prepare(`SELECT id,display_name,category,health,harvest_tier,
    consecutive_failures,last_success_at,last_http_code,last_error,latest_item_at,enabled
    FROM sources ORDER BY CASE health WHEN 'failing' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, id`).all(),
  harvests: () => db.prepare(`SELECT * FROM harvest_runs ORDER BY id DESC LIMIT 12`).all(),
  runs: () => db.prepare(`SELECT r.*, (SELECT count(*) FROM candidates c WHERE c.run_id=r.id) cands
    FROM runs r ORDER BY r.id DESC LIMIT 30`).all(),
  run: (id: number) => db.prepare('SELECT * FROM runs WHERE id=?').get(id),
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
  }),
  audit: (limit = 100) => db.prepare(`SELECT * FROM audit_events ORDER BY id DESC LIMIT ?`).all(limit),
};

app.get('/', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  return reply.type('text/html; charset=utf-8').send(renderDashboard({
    csrf: s.csrf, sources: q.sources() as any, harvests: q.harvests() as any,
    runs: q.runs() as any, stats: q.stats() as any,
  }));
});

app.get('/sources', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  return reply.type('text/html; charset=utf-8')
    .send(renderSources({ csrf: s.csrf, sources: q.sources() as any }));
});

app.get('/runs', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  return reply.type('text/html; charset=utf-8')
    .send(renderRuns({ csrf: s.csrf, runs: q.runs() as any, harvests: q.harvests() as any }));
});

app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  const id = Number(req.params.id);
  const run = q.run(id);
  if (!run) return reply.code(404).type('text/html; charset=utf-8')
    .send(layout('未找到', '<p>没有该运行记录。</p>', s.csrf));
  return reply.type('text/html; charset=utf-8')
    .send(renderRunDetail({ csrf: s.csrf, run: run as any, candidates: q.candidates(id) as any }));
});

app.get('/audit', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  return reply.type('text/html; charset=utf-8')
    .send(renderAudit({ csrf: s.csrf, events: q.audit() as any }));
});

// ---------- 只读 API ----------
app.get('/api/v1/dashboard', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return { sources: q.sources(), harvests: q.harvests(), runs: q.runs(), stats: q.stats() };
});
app.get('/api/v1/sources', async (req, reply) => {
  if (!requireAuth(req, reply)) return; return q.sources();
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
  const names = ['AI_PROVIDER','AI_L1_MODEL','AI_L2_MODEL','AI_L3_MODEL',
                 'AI_L2_PROVIDER','AI_L3_PROVIDER', ...SECRET_NAMES];
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
      l1Model: String(b.l1_model ?? '').trim(),
      l2Model: String(b.l2_model ?? '').trim(),
      l3Model: String(b.l3_model ?? '').trim(),
      l2Provider: String(b.l2_provider ?? '').trim(),
      l3Provider: String(b.l3_provider ?? '').trim(),
    });
    db.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at)
      VALUES ('settings','ai','ai_settings_updated',?,?)`)
      .run(JSON.stringify({ provider: b.ai_provider, l1: b.l1_model, actor: 'owner' }), nowIso());
    return reply.type('text/html; charset=utf-8').send(settingsPage(s, { saved: '供应商设置已保存。worker 下次运行即生效。' }));
  } catch (e: any) {
    return reply.code(500).type('text/html; charset=utf-8').send(settingsPage(s, { error: String(e?.message ?? e) }));
  }
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
