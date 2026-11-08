// 后台路由：全网热点入口已移除（页面、路由、设置、RSS 均 404）；RSS 访问日志不泄露令牌（原 allnet-integration 中的通用检查）
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openDb, migrate } from '../packages/db/src/index.ts';
import { hashPassword } from '../packages/web/src/auth.ts';
import { spawnSync } from 'node:child_process';
import { toggleSource, deleteSource, updateSourceGroup } from '../packages/web/src/actions.ts';

const dir = mkdtempSync(join(tmpdir(), 'admin-routes-'));
const dbpath = join(dir, 'test.db');
const db = openDb(dbpath); migrate(db, 'migrations');
// 阶段一上线后、阶段二删数据前的生产状态：遗留的全网热点来源（停用、无端点）与它的订阅和令牌仍在库里
const nowIso = new Date().toISOString();
const LEGACY_TOKEN = 'c'.repeat(64);
db.prepare(`INSERT INTO sources(id,name,display_name,category,host_group,harvest_tier,config_json,source_version,managed_by,enabled,created_at,updated_at)
  VALUES('allnet_legacy','legacy','遗留热搜来源','society','allnet','ranking_feed','{}',1,'admin',0,?,?)`).run(nowIso, nowIso);
db.prepare(`INSERT INTO allnet_subscriptions(source_id,upstream_id,item_limit,kind,token) VALUES('allnet_legacy',76,15,'ranking',?)`).run(LEGACY_TOKEN);
assert.throws(() => toggleSource(db, 'allnet_legacy', true, 'try enable'), /已下线/);
assert.throws(() => deleteSource(db, 'allnet_legacy', 'try delete'), /已下线/);
assert.throws(() => updateSourceGroup(db, 'allnet_legacy', 'other', 'try regroup'), /已下线|未知来源分组/);
db.prepare(`UPDATE sources SET enabled=1 WHERE id='allnet_legacy'`).run();   // 即使被直接改库启用，采集也不碰它
const h = spawnSync(process.execPath, ['apps/worker/src/harvest.ts', '--all'], { encoding: 'utf8', env: { ...process.env, DATABASE_PATH: dbpath, SNAPSHOT_DIR: join(dir, 'snap') } });
assert.ok(!`${h.stdout}${h.stderr}`.includes('allnet_legacy'), '遗留全网热点来源不得被采集');
db.prepare(`UPDATE sources SET enabled=0 WHERE id='allnet_legacy'`).run();
console.log('  ✅ 遗留全网热点来源不能启用、删除或改分组，采集不会碰它');
const env = { ...process.env, DATABASE_PATH: dbpath, TELEGRAM_DATABASE_PATH: join(dir, 'tg.sqlite3'), TELEGRAM_SESSION_PATH: join(dir, 'tgs'),
  TELEGRAM_LOGIN_SOCKET: join(dir, 'tg.sock'), SECRETS_PATH: join(dir, 'secrets.enc'), REQUEST_DIR: join(dir, 'req'), BACKUP_DIR: join(dir, 'bak'),
  BACKUP_SETTINGS_PATH: join(dir, 'backup-settings.json'), ADMIN_PASSWORD_HASH: hashPassword('test-pass'), ADMIN_TOTP_SECRET: '',
  ADMIN_PORT: '3196', ADMIN_SECURE_COOKIE: 'false', ADMIN_BASE_URL: 'http://127.0.0.1:3196' };
let child: ReturnType<typeof spawn> | undefined;
try {
  let logs = '';
  child = spawn(process.execPath, ['apps/web/src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', b => logs += b); child.stderr!.on('data', b => logs += b);
  const base = 'http://127.0.0.1:3196';
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health/live')).ok) break; } catch { /* 启动中 */ } await new Promise(r => setTimeout(r, 50)); }
  const login = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ password: 'test-pass' }), redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const get = (p: string) => fetch(base + p, { headers: { cookie }, redirect: 'manual' });

  for (const p of ['/allnet', '/rss/allnet/' + 'a'.repeat(64)]) assert.equal((await get(p)).status, 404, `${p} 应已移除`);
  for (const p of ['/allnet/search', '/sources/allnet/search', '/allnet/add', '/allnet/x/toggle', '/allnet/x/token', '/settings/allnet/test'])
    assert.equal((await fetch(base + p, { method: 'POST', headers: { cookie }, body: new URLSearchParams({}) })).status, 404, `${p} 应已移除`);
  const sources = await (await get('/sources')).text();
  const settings = await (await get('/settings')).text();
  const feeds = await (await get('/feeds')).text();
  for (const [name, html] of [['来源页', sources], ['设置页', settings], ['订阅页', feeds]] as const)
    assert.ok(!html.includes('全网热点') && !html.includes('ALLNET') && !html.includes('遗留热搜来源'), `${name}不应再出现全网热点或遗留来源`);
  console.log('  ✅ 全网热点页面、路由、设置与 RSS 均已移除');

  // RSS 访问日志不记录令牌：包括已下线的 /rss/allnet/<令牌>（走 404 处理，默认处理会把完整网址写进日志）
  const token = 'b'.repeat(64);
  await fetch(base + '/rss/briefs/' + token);
  assert.equal((await fetch(base + '/rss/allnet/' + LEGACY_TOKEN)).status, 404);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!logs.includes(token), '访问日志不得包含 RSS 令牌');
  assert.ok(!logs.includes(LEGACY_TOKEN), '已下线的 /rss/allnet/<令牌> 请求不得把令牌写进日志');
  console.log('  ✅ RSS 访问日志隐藏令牌');
  console.log('\n✅ 全部通过');
} finally {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  db.close(); rmSync(dir, { recursive: true, force: true });
}
