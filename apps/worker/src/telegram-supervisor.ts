#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolveSecret } from '../../../packages/web/src/secrets.ts';
import { readyTelegramDb } from '../../../packages/telegram/src/db.ts';

const apiId=resolveSecret('TELEGRAM_API_ID'), apiHash=resolveSecret('TELEGRAM_API_HASH'), phone=resolveSecret('TELEGRAM_PHONE');
if(!apiId||!/^\d+$/.test(apiId)||!apiHash) throw new Error('Telegram 凭据未完整配置到共享密钥库');
const db=readyTelegramDb();db.close();
const python=process.env.TELEGRAM_PYTHON??'./telegram-worker/.venv/bin/python';
const child=spawn(python,['-m','briefing_telegram.worker'],{
  cwd:process.cwd(),stdio:'inherit',env:{...process.env,TELEGRAM_API_ID:apiId,TELEGRAM_API_HASH:apiHash,TELEGRAM_PHONE:phone??'',
    TELEGRAM_DATABASE_PATH:process.env.TELEGRAM_DATABASE_PATH??'./data/telegram.sqlite3',TELEGRAM_SESSION_PATH:process.env.TELEGRAM_SESSION_PATH??'./data/telegram',
    TELEGRAM_LOGIN_SOCKET:process.env.TELEGRAM_LOGIN_SOCKET??'./data/telegram-login.sock'},
});
for(const signal of ['SIGINT','SIGTERM'] as NodeJS.Signals[]) process.on(signal,()=>child.kill(signal));
child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exit(code??1)});
