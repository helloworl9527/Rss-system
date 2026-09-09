#!/usr/bin/env node
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { readyTelegramDb } from '../packages/telegram/src/db.ts';
import { loadVault, saveVault, vaultPath } from '../packages/web/src/secrets.ts';
import { rotateAllToken, rotateSourceToken } from '../packages/telegram/src/core.ts';

const sourceDir=resolve(process.argv[2]??'../Telegram-channel-compact');
const oldDbPath=join(sourceDir,'data/telegram.sqlite3'), oldSession=join(sourceDir,'data/telegram.session');
const targetDb=resolve(process.env.TELEGRAM_DATABASE_PATH??'./data/telegram.sqlite3');
const configuredSession=resolve(process.env.TELEGRAM_SESSION_PATH??'./data/telegram');
const targetSession=configuredSession.endsWith('.session')?configuredSession:`${configuredSession}.session`;
const briefDb=resolve(process.env.DATABASE_PATH??'./data/brief.db');
const secretFile=resolve(vaultPath());
const backupDir=resolve(process.env.MIGRATION_BACKUP_DIR??'./data/migration-backups');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const sqliteBackup=async(src,dest)=>{const db=new Database(src,{readonly:true});try{await db.backup(dest)}finally{db.close()}chmodSync(dest,0o600)};
const parseEnv=p=>Object.fromEntries(readFileSync(p,'utf8').split(/\r?\n/).filter(x=>/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)).map(line=>{const i=line.indexOf('=');let v=line.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);return[line.slice(0,i),v]}));

if(!existsSync(oldDbPath)||!existsSync(oldSession)) throw new Error('找不到原 Telegram 数据库或会话文件');
// Credential conflicts are checked before target data is mutated.
const oldEnv=parseEnv(join(sourceDir,'.env'));
const incoming={TELEGRAM_API_ID:oldEnv.TG_COLLECTOR_TELEGRAM_API_ID,TELEGRAM_API_HASH:oldEnv.TG_COLLECTOR_TELEGRAM_API_HASH,
  TELEGRAM_PHONE:oldEnv.TG_COLLECTOR_TELEGRAM_PHONE,OPENAI_COMPAT_API_KEY:oldEnv.TG_COLLECTOR_OPENAI_API_KEY};
const vault=loadVault(vaultPath());
for(const [name,value] of Object.entries(incoming)) if(value&&vault.secrets[name]&&vault.secrets[name]!==value)
  throw new Error(`目标密钥槽 ${name} 已有不同值；迁移已停止且不会覆盖`);
for(const [name,value] of Object.entries(incoming)) if(value)vault.secrets[name]=value;
vault.settings.telegramProvider='openai_compatible';
vault.settings.telegramBaseUrl=oldEnv.TG_COLLECTOR_OPENAI_BASE_URL??'';
vault.settings.telegramModel=oldEnv.TG_COLLECTOR_OPENAI_MODEL??'';

mkdirSync(backupDir,{recursive:true,mode:0o700});chmodSync(backupDir,0o700);
copyFileSync(oldSession,join(backupDir,`source-${stamp}-${basename(oldSession)}`));
const sourceDbBackup=join(backupDir,`source-${stamp}-${basename(oldDbPath)}`);await sqliteBackup(oldDbPath,sourceDbBackup);
const backups=[sourceDbBackup,join(backupDir,`source-${stamp}-${basename(oldSession)}`)];
if(existsSync(briefDb)){const p=join(backupDir,`brief-${stamp}-${basename(briefDb)}`);await sqliteBackup(briefDb,p);backups.push(p)}
if(existsSync(secretFile)){const p=join(backupDir,`secrets-${stamp}-${basename(secretFile)}`);copyFileSync(secretFile,p);backups.push(p)}
for(const f of backups)chmodSync(f,0o600);
if(existsSync(targetDb)){const p=join(backupDir,`target-${stamp}-${basename(targetDb)}`);await sqliteBackup(targetDb,p)}
saveVault(vault,vaultPath());

const old=new Database(oldDbPath,{readonly:true}); const target=readyTelegramDb(targetDb);
try{
  const chat=old.prepare('SELECT * FROM chats ORDER BY chat_id LIMIT 1').get(); if(!chat)throw new Error('原数据库没有来源');
  let source=target.prepare('SELECT id FROM telegram_sources WHERE chat_id=?').get(chat.chat_id);
  if(existsSync(targetSession)&&hash(targetSession)!==hash(oldSession)&&!source)
    throw new Error('目标会话文件已存在且内容不同，且目标库没有已迁移来源；迁移已停止');
  if(!source){const now=new Date().toISOString();const r=target.prepare(`INSERT INTO telegram_sources(reference,display_name,source_type,chat_id,title,username,telegram_kind,status,enabled,validation_requested_at,validated_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'active',1,?,?,?,?)`).run(chat.username?`@${chat.username}`:String(chat.chat_id),chat.title,'normal',chat.chat_id,chat.title,chat.username,chat.kind,now,now,now,now);source={id:Number(r.lastInsertRowid)}}
  const insert=target.prepare(`INSERT OR IGNORE INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,edited_at,reply_to_id,source_url,content_hash,collected_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const version=target.prepare(`INSERT OR IGNORE INTO telegram_message_versions(chat_id,message_id,content_hash,text,edited_at,collected_at) VALUES(?,?,?,?,?,?)`);
  target.transaction(()=>{for(const m of old.prepare('SELECT * FROM messages').iterate()){const digest=createHash('sha256').update(m.text).digest('hex');insert.run(source.id,m.chat_id,m.message_id,m.sent_at,m.text,m.edited_at,m.reply_to_id,m.source_url,digest,m.collected_at,m.deleted_at)}
    for(const v of old.prepare('SELECT * FROM message_versions').iterate())version.run(v.chat_id,v.message_id,v.content_hash,v.text,v.edited_at,v.collected_at);
    const state=old.prepare('SELECT * FROM sync_state WHERE chat_id=?').get(chat.chat_id);target.prepare(`INSERT INTO telegram_sync_state(source_id,last_message_id,last_synced_at,last_error,last_window_end) VALUES(?,?,?,?,NULL)
      ON CONFLICT(source_id) DO UPDATE SET last_message_id=max(telegram_sync_state.last_message_id,excluded.last_message_id),
      last_synced_at=CASE WHEN telegram_sync_state.last_synced_at IS NULL THEN excluded.last_synced_at
        WHEN excluded.last_synced_at IS NULL THEN telegram_sync_state.last_synced_at ELSE max(telegram_sync_state.last_synced_at,excluded.last_synced_at) END,
      last_error=coalesce(telegram_sync_state.last_error,excluded.last_error)`)
      .run(source.id,state?.last_message_id??0,state?.last_synced_at??null,state?.last_error??null)})();
  if(!(target.prepare('SELECT rss_token FROM telegram_sources WHERE id=?').get(source.id)).rss_token)rotateSourceToken(target,source.id);
  if(!(target.prepare('SELECT all_rss_token FROM telegram_settings').get()).all_rss_token)rotateAllToken(target);
  target.prepare(`UPDATE telegram_settings SET provider='openai_compatible',model=?,base_url=?,credential_ref='OPENAI_COMPAT_API_KEY',updated_at=? WHERE singleton=1`).run(oldEnv.TG_COLLECTOR_OPENAI_MODEL??'',oldEnv.TG_COLLECTOR_OPENAI_BASE_URL??null,new Date().toISOString());
  const before=old.prepare('SELECT count(*) n FROM messages').get().n;
  let migrated=0;for(const m of old.prepare('SELECT chat_id,message_id FROM messages').iterate())
    if(target.prepare('SELECT 1 FROM telegram_messages WHERE chat_id=? AND message_id=?').get(m.chat_id,m.message_id))migrated++;
  const after=target.prepare('SELECT count(*) n FROM telegram_messages WHERE source_id=?').get(source.id).n;
  if(before!==migrated)throw new Error(`原消息迁移不完整：${migrated}/${before}`);
  if(target.pragma('integrity_check',{simple:true})!=='ok'||old.pragma('integrity_check',{simple:true})!=='ok')throw new Error('数据库 integrity_check 失败');
  mkdirSync(dirname(targetSession),{recursive:true,mode:0o700});if(!existsSync(targetSession))copyFileSync(oldSession,targetSession);chmodSync(targetSession,0o600);chmodSync(targetDb,0o600);
  console.log(`迁移完成：来源 1，原消息 ${migrated}/${before}，目标现有消息 ${after}，两个数据库 integrity_check=ok；原目录保留未改动。`);
}finally{old.close();target.close()}
