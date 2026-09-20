import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'brief-subscriptions-'));
try {
  const briefingPath = join(dir, 'brief.db');
  const telegramPath = join(dir, 'telegram.db');
  const output = join(dir, 'SUBSCRIPTIONS.md');
  const briefing = new Database(briefingPath);
  briefing.exec(`
    CREATE TABLE sources(id TEXT PRIMARY KEY,name TEXT,display_name TEXT,category TEXT,source_group TEXT,
      enabled INTEGER,priority INTEGER,site_url TEXT);
    CREATE TABLE source_endpoints(source_id TEXT,priority INTEGER,url TEXT,enabled INTEGER);
    INSERT INTO sources VALUES('safe','Safe Feed','Safe Feed','tech','google',1,1,'https://example.com/');
    INSERT INTO source_endpoints VALUES('safe',1,'https://example.com/feed.xml',1);
    INSERT INTO source_endpoints VALUES('safe',2,'https://example.com/private?token=do-not-publish',1);
    INSERT INTO sources VALUES('off','Disabled','Disabled','tech','google',0,2,'https://disabled.example/');
  `);
  briefing.close();
  const telegram = new Database(telegramPath);
  telegram.exec(`
    CREATE TABLE telegram_sources(id INTEGER PRIMARY KEY,reference TEXT,display_name TEXT,title TEXT,username TEXT,
      source_type TEXT,status TEXT,enabled INTEGER);
    INSERT INTO telegram_sources VALUES(1,'t.me/+private-secret','Public Channel Name',NULL,NULL,'normal','active',1);
    INSERT INTO telegram_sources VALUES(2,'t.me/c/123',NULL,NULL,NULL,'normal','error',0);
  `);
  telegram.close();

  execFileSync(process.execPath, ['scripts/sync-public-subscriptions.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: briefingPath, TELEGRAM_DATABASE_PATH: telegramPath,
      PUBLIC_SUBSCRIPTIONS_REPO: dir, PUBLIC_SUBSCRIPTIONS_FILE: 'SUBSCRIPTIONS.md' },
  });
  const result = readFileSync(output, 'utf8');
  assert.match(result, /Safe Feed/);
  assert.match(result, /https:\/\/example\.com\/feed\.xml/);
  assert.match(result, /Public Channel Name/);
  assert.doesNotMatch(result, /do-not-publish|private-secret|t\.me\/c\/123|Disabled/);
  console.log('✓ 公开订阅清单生成与敏感字段隔离测试通过');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
