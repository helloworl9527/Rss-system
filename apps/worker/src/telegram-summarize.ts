#!/usr/bin/env node
import { readyTelegramDb } from '../../../packages/telegram/src/db.ts';
import { runDueSummaries } from '../../../packages/telegram/src/summarize.ts';
import { resolveSecret } from '../../../packages/web/src/secrets.ts';

const db=readyTelegramDb();
try {
  const settings=db.prepare('SELECT credential_ref FROM telegram_settings WHERE singleton=1').get() as any;
  const done=await runDueSummaries(db,resolveSecret(settings.credential_ref));
  console.log(`Telegram 总结完成 ${done} 个窗口`);
} finally { db.close(); }
