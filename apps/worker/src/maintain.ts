#!/usr/bin/env node
/**
 * 日常维护：SQLite 在线备份 + 快照过期清理（计划 3.5 / PRD 13.3）。
 * 用 better-sqlite3 的 backup() API，不依赖 sqlite3 CLI（本机未安装）。
 */
import { readdirSync, statSync, unlinkSync, rmdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { openDb, nowIso } from '../../../packages/db/src/index.ts';
import { readyTelegramDb } from '../../../packages/telegram/src/db.ts';
import { cleanupTelegram } from '../../../packages/telegram/src/maintenance.ts';

const DB_PATH = process.env.DATABASE_PATH ?? './data/brief.db';
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/var/lib/briefing/backups';
const SNAP_DIR = process.env.SNAPSHOT_DIR ?? './data/snapshots';
const KEEP_DAILY = Number(process.env.BACKUP_KEEP_DAILY ?? 14);   // PRD 13.3
const KEEP_WEEKLY = Number(process.env.BACKUP_KEEP_WEEKLY ?? 8);

const db = openDb(DB_PATH);
mkdirSync(BACKUP_DIR, { recursive: true });

// ---- 1. 在线备份（不阻塞写入） ----
const stamp = new Date().toISOString().slice(0, 10);
const tmp = join(BACKUP_DIR, `brief-${stamp}.db`);
await db.backup(tmp);
const gz = gzipSync(readFileSync(tmp));
const out = `${tmp}.gz`;
writeFileSync(out, gz);
unlinkSync(tmp);
console.log(`备份: ${out} (${(gz.byteLength / 1024).toFixed(0)} KB)`);

// ---- 2. 备份保留：日备 14 份，每周一的另留 8 份 ----
const backups = readdirSync(BACKUP_DIR).filter(f => /^brief-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(f)).sort().reverse();
const weekly = backups.filter(f => new Date(f.slice(6, 16)).getUTCDay() === 1);
const keep = new Set([...backups.slice(0, KEEP_DAILY), ...weekly.slice(0, KEEP_WEEKLY)]);
let removed = 0;
for (const f of backups) if (!keep.has(f)) { unlinkSync(join(BACKUP_DIR, f)); removed++; }
console.log(`备份保留 ${keep.size} 份，清理 ${removed} 份`);

// ---- 3. 快照过期清理（PRD 13.3：压缩保留 30 天） ----
const expired = db.prepare('SELECT id, storage_path FROM raw_snapshots WHERE expires_at < ?')
  .all(nowIso()) as Array<{ id: number; storage_path: string }>;
const del = db.prepare('DELETE FROM raw_snapshots WHERE id = ?');
let gone = 0;
db.transaction(() => {
  for (const s of expired) {
    try { if (existsSync(s.storage_path)) unlinkSync(s.storage_path); } catch { /* 文件已不在，仍删记录 */ }
    del.run(s.id); gone++;
  }
})();
// 清理空目录
const prune = (dir: string): void => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) prune(p);
  }
  try { if (readdirSync(dir).length === 0 && dir !== SNAP_DIR) rmdirSync(dir); } catch { /* 非空 */ }
};
prune(SNAP_DIR);
console.log(`快照清理 ${gone} 个过期条目`);

// ---- 4. WAL checkpoint，防止 -wal 文件无限增长 ----
db.pragma('wal_checkpoint(TRUNCATE)');
const size = statSync(DB_PATH).size;
console.log(`数据库 ${(size / 1024 / 1024).toFixed(1)} MB，WAL 已 checkpoint`);
db.close();

// ---- 5. Telegram 使用独立数据库，但共享同一维护生命周期 ----
const telegramPath = process.env.TELEGRAM_DATABASE_PATH ?? './data/telegram.sqlite3';
const telegramDb = readyTelegramDb(telegramPath);
const telegramTmp = join(BACKUP_DIR, `telegram-${stamp}.db`);
await telegramDb.backup(telegramTmp);
const telegramGz = gzipSync(readFileSync(telegramTmp));
writeFileSync(`${telegramTmp}.gz`, telegramGz);
unlinkSync(telegramTmp);
const telegramBackups = readdirSync(BACKUP_DIR).filter(f => /^telegram-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(f)).sort().reverse();
const telegramWeekly = telegramBackups.filter(f => new Date(f.slice(9, 19)).getUTCDay() === 1);
const telegramKeep = new Set([...telegramBackups.slice(0, KEEP_DAILY), ...telegramWeekly.slice(0, KEEP_WEEKLY)]);
for (const f of telegramBackups) if (!telegramKeep.has(f)) unlinkSync(join(BACKUP_DIR, f));
const telegramCleaned = cleanupTelegram(telegramDb);
telegramDb.pragma('wal_checkpoint(TRUNCATE)');
console.log(`Telegram 备份: ${telegramTmp}.gz；清理消息 ${telegramCleaned.messages}、URL ${telegramCleaned.urls}、总结 ${telegramCleaned.summaries}`);
telegramDb.close();
