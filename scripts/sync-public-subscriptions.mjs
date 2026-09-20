#!/usr/bin/env node
/**
 * Generate the public subscription inventory and optionally publish it.
 *
 * The inventory deliberately contains only public feed URLs and Telegram
 * display names.  It must never contain RSS tokens, Telegram references,
 * chat IDs, message text, or credentials.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

const repo = resolve(process.env.PUBLIC_SUBSCRIPTIONS_REPO ?? process.cwd());
const output = resolve(repo, process.env.PUBLIC_SUBSCRIPTIONS_FILE ?? 'SUBSCRIPTIONS.md');
const briefingDbPath = process.env.DATABASE_PATH ?? '/var/lib/briefing/brief.db';
const telegramDbPath = process.env.TELEGRAM_DATABASE_PATH ?? '/var/lib/briefing/telegram.sqlite3';
const publish = process.argv.includes('--publish');
const githubRepo = process.env.PUBLIC_SUBSCRIPTIONS_GITHUB_REPO ?? 'helloworl9527/Rss-system';
const githubPath = process.env.PUBLIC_SUBSCRIPTIONS_GITHUB_PATH ?? 'SUBSCRIPTIONS.md';

function db(path) {
  if (!existsSync(path)) throw new Error(`数据库不存在：${path}`);
  return new Database(path, { readonly: true, fileMustExist: true });
}

function text(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cell(value) { return text(value).replaceAll('|', '\\|') || '—'; }

function publicUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return null;
    const sensitive = /^(?:access_?token|api_?key|auth|authorization|key|password|secret|signature|token)$/i;
    if ([...url.searchParams.keys()].some((key) => sensitive.test(key))) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

function sourceRows() {
  const d = db(briefingDbPath);
  try {
    const sources = d.prepare(`SELECT id,name,display_name,category,source_group,enabled,site_url
      FROM sources WHERE enabled=1 ORDER BY priority,id`).all();
    const endpoints = d.prepare(`SELECT source_id,priority,url FROM source_endpoints
      WHERE enabled=1 ORDER BY source_id,priority`).all();
    const byId = new Map();
    for (const endpoint of endpoints) {
      const url = publicUrl(endpoint.url);
      if (!url) continue;
      const list = byId.get(endpoint.source_id) ?? [];
      list.push({ priority: endpoint.priority, url });
      byId.set(endpoint.source_id, list);
    }
    return sources.map((source) => ({
      id: source.id,
      name: source.display_name || source.name,
      category: source.category,
      group: source.source_group,
      site: publicUrl(source.site_url),
      endpoints: byId.get(source.id) ?? [],
    })).filter((source) => source.endpoints.length > 0 || source.site);
  } finally { d.close(); }
}

function telegramRows() {
  const d = db(telegramDbPath);
  try {
    return d.prepare(`SELECT display_name,title,username,source_type,status,enabled
      FROM telegram_sources ORDER BY id`).all().map((source) => ({
      // Never fall back to reference: it may be a private invite or t.me/c URL.
      name: source.display_name || source.title || (source.username ? `@${source.username}` : '（频道名称未解析）'),
      type: source.source_type === 'url' ? 'URL 提取' : '普通总结',
      state: source.enabled ? '启用' : `未启用（${source.status}）`,
    }));
  } finally { d.close(); }
}

function render() {
  const sources = sourceRows();
  const telegram = telegramRows();
  const lines = [
    '# 日报订阅清单',
    '',
    '> 此文件由生产环境自动生成。仅列出日报 Feed 链接和 Telegram 订阅名称。',
    '> 不包含 RSS token、Telegram 私有链接、chat_id、消息内容或 API 凭据。',
    '',
    '## 日报订阅源',
    '',
    '| 来源 | 分类 | 分组 | 站点 | Feed / Atom |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const source of sources) {
    const site = source.site ? `<${source.site}>` : '—';
    const feeds = source.endpoints.map((endpoint) => `<${endpoint.url}>`).join('<br>') || '—';
    lines.push(`| ${cell(source.name)} | ${cell(source.category)} | ${cell(source.group)} | ${site} | ${feeds} |`);
  }
  lines.push('', `共 ${sources.length} 个启用的日报来源。`, '', '## Telegram 订阅频道', '',
    '| 频道名称 | 类型 | 状态 |', '| --- | --- | --- |');
  for (const source of telegram)
    lines.push(`| ${cell(source.name)} | ${cell(source.type)} | ${cell(source.state)} |`);
  lines.push('', `共 ${telegram.length} 个 Telegram 订阅。`, '');
  return lines.join('\n');
}

const content = render();
if (!publish) {
  const previous = existsSync(output) ? readFileSync(output, 'utf8') : null;
  if (previous === content) console.log('订阅清单无变化');
  else {
    writeFileSync(output, content, { encoding: 'utf8', mode: 0o644 });
    console.log(`已更新 ${output}`);
  }
  process.exit(0);
}

const gh = (args) => execFileSync('/usr/bin/gh', args,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let remote = null;
try {
  remote = JSON.parse(gh(['api', '--method', 'GET', `repos/${githubRepo}/contents/${githubPath}`, '-f', 'ref=main']));
} catch (error) {
  const message = String(error?.stderr ?? error);
  if (!/404|Not Found/i.test(message)) throw error;
}
const existing = remote?.content
  ? Buffer.from(String(remote.content).replace(/\s/g, ''), 'base64').toString('utf8')
  : null;
if (existing === content) {
  console.log('GitHub 订阅清单无变化');
  process.exit(0);
}
const args = ['api', '--method', 'PUT', `repos/${githubRepo}/contents/${githubPath}`,
  '-f', 'message=chore: sync public subscription inventory',
  '-f', `content=${Buffer.from(content).toString('base64')}`,
  '-f', 'branch=main'];
if (remote?.sha) args.push('-f', `sha=${remote.sha}`);
gh(args);
console.log('GitHub 订阅清单已更新');
