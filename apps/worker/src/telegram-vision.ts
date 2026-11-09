#!/usr/bin/env node
import { readyTelegramDb } from '../../../packages/telegram/src/db.ts';
import { recoverVisionFiles, runOneVisionTask } from '../../../packages/telegram/src/vision.ts';
import { resolveSecret } from '../../../packages/web/src/secrets.ts';
import { telegramPick, legacyFingerprint, legacyTelegramConfig } from '../../../packages/web/src/model-runtime.ts';

const db = readyTelegramDb();
try {
  const settings = db.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get() as any;
  const removed = recoverVisionFiles(db);
  // 每次只处理一个任务：在这里解析就是「领取前解析」。配置错误时不领取、不删图、不暂停队列
  const pick = telegramPick('telegramVision');
  let result: string;
  if (pick && !pick.ok) {
    result = 'config_error';
    console.log(`Telegram 图片识别：模型配置错误（${pick.error}），本轮不领取任务`);
  } else {
    const current = () => {
      const p = telegramPick('telegramVision');
      if (p === null) return legacyFingerprint(legacyTelegramConfig(db.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get(), 'telegramVision'));
      return p.ok ? p.fingerprint : null;
    };
    result = await runOneVisionTask(db, pick
      ? { model: pick.cfg, fingerprint: pick.fingerprint, currentFingerprint: current }
      : { apiKey: resolveSecret(settings.vision_credential_ref), fingerprint: legacyFingerprint(legacyTelegramConfig(settings, 'telegramVision')), currentFingerprint: current });
  }
  db.prepare(`UPDATE telegram_settings SET vision_last_run_at=?,vision_last_result=?,updated_at=? WHERE singleton=1`)
    .run(new Date().toISOString(), result, new Date().toISOString());
  console.log(`Telegram 图片识别：${result}；清理孤儿文件 ${removed}`);
} finally { db.close(); }
