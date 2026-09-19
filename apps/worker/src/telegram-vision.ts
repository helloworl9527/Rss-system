#!/usr/bin/env node
import { readyTelegramDb } from '../../../packages/telegram/src/db.ts';
import { recoverVisionFiles, runOneVisionTask } from '../../../packages/telegram/src/vision.ts';
import { resolveSecret } from '../../../packages/web/src/secrets.ts';

const db = readyTelegramDb();
try {
  const settings = db.prepare('SELECT vision_credential_ref FROM telegram_settings WHERE singleton=1').get() as any;
  const removed = recoverVisionFiles(db);
  const result = await runOneVisionTask(db, { apiKey: resolveSecret(settings.vision_credential_ref) });
  db.prepare(`UPDATE telegram_settings SET vision_last_run_at=?,vision_last_result=?,updated_at=? WHERE singleton=1`)
    .run(new Date().toISOString(), result, new Date().toISOString());
  console.log(`Telegram 图片识别：${result}；清理孤儿文件 ${removed}`);
} finally { db.close(); }
