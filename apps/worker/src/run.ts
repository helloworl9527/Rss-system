#!/usr/bin/env node
/**
 * 完整简报运行（PRD 12.1 端到端时序）。
 *
 *   node apps/worker/src/run.ts                自动窗口，按配置投递
 *   node apps/worker/src/run.ts --window K     指定窗口
 *   node apps/worker/src/run.ts --no-send      只生成不投递
 *   node apps/worker/src/run.ts --shadow       影子投递
 *
 * 依次执行：候选构建 → L1 判定 → L2/L3 复核 → 简报组装与投递。
 * 每一步都是独立可重入的 CLI，这里只负责串联与失败处理 ——
 * 任一步失败不吞掉错误，运行进入 partial 并保留已完成的成果
 * （PRD 12.2：任一来源失败但仍可生成简报时状态为 partial）。
 */
import { spawn } from 'node:child_process';
import { openDb, nowIso, type DB } from '../../../packages/db/src/index.ts';
import { windowOf, windowFromKey } from '../../../packages/domain/src/normalize.ts';

const argv = process.argv.slice(2);
const winArg = argv.includes('--window') ? argv[argv.indexOf('--window') + 1] : null;
const passThrough = argv.filter(a => ['--no-send', '--shadow', '--regenerate'].includes(a));

const win = winArg && winArg !== 'auto' ? windowFromKey(winArg) : windowOf();
const db: DB = openDb(process.env.DATABASE_PATH ?? './data/brief.db');

/** 跑一个子步骤，实时透传输出。返回退出码。 */
function step(name: string, script: string, args: string[]): Promise<number> {
  return new Promise(resolve => {
    console.log(`\n${'─'.repeat(58)}\n▶ ${name}\n${'─'.repeat(58)}`);
    const p = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    p.on('close', code => resolve(code ?? 1));
    p.on('error', e => { console.error(`  启动失败: ${e.message}`); resolve(1); });
  });
}

const t0 = Date.now();
console.log(`简报运行 ${win.key} ${win.label}  [${win.start.toISOString()} → ${win.end.toISOString()})`);

// 1. 候选构建（含三窗口复查补录）
let code = await step('候选构建', 'apps/worker/src/candidates.ts', ['--window', win.key]);
if (code !== 0) {
  console.error('\n❌ 候选构建失败，中止 —— 后续步骤没有输入');
  markRun('failed', '候选构建失败');
  db.close(); process.exit(1);
}

const runRow = db.prepare('SELECT id FROM runs WHERE window_key=?').get(win.key) as any;
if (!runRow) { console.error('未找到运行记录'); db.close(); process.exit(1); }
const runId = runRow.id;
const nCand = (db.prepare('SELECT count(*) c FROM candidates WHERE run_id=?').get(runId) as any).c;

if (!nCand) {
  console.log('\n本窗口没有候选，不生成简报。');
  markRun('succeeded', null, 'composing');
  db.close(); process.exit(0);
}

// 2. L1 判定
const failures: string[] = [];
code = await step('L1 判定', 'apps/worker/src/triage.ts', ['--run', String(runId)]);
if (code !== 0) failures.push('L1 判定');

// 3. L2/L3 复核（无待复核候选时会自行跳过）
code = await step('L2/L3 复核', 'apps/worker/src/review.ts', ['--run', String(runId)]);
if (code !== 0) failures.push('L2/L3 复核');

// 4. 简报组装与投递
code = await step('简报组装与投递', 'apps/worker/src/brief.ts', ['--run', String(runId), ...passThrough]);
if (code !== 0) failures.push('简报组装');

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n${'═'.repeat(58)}`);
if (failures.length) {
  console.log(`⚠️  运行完成但有失败步骤：${failures.join('、')}  （耗时 ${secs}s）`);
  markRun('partial', failures.join('、'));
} else {
  console.log(`✅ 运行完成  （耗时 ${secs}s）`);
  markRun('succeeded', null);
}

function markRun(status: string, error: string | null, stage = 'sending') {
  db.prepare(`UPDATE runs SET status=?, stage=?, finished_at=?, error=? WHERE window_key=?`)
    .run(status, stage, nowIso(), error, win.key);
  db.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at)
    VALUES ('run',?,?,?,?)`)
    .run(win.key, `run_${status}`, JSON.stringify({ error, seconds: Number(secsSafe()) }), nowIso());
}
function secsSafe() { return ((Date.now() - t0) / 1000).toFixed(0); }

db.close();
process.exit(failures.length ? 2 : 0);
