import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 加密密钥存储（PRD 19.2）。
 *
 * 设计取舍：
 *  · 不放数据库 —— 数据库每天备份，密钥会随之进备份文件，
 *    而 PRD 19.2 明确要求 API key 不进备份明文。
 *  · 独立文件 0600 brief:brief，用 AES-256-GCM 加密。
 *  · 主密钥 APP_ENCRYPTION_KEY 放 /etc/briefing/env（0640 root:brief）——
 *    web 进程能读主密钥、能读写密文文件，但改不了主密钥本身。
 *    磁盘镜像或密文文件单独泄露时，没有主密钥仍解不开。
 *  · GCM 自带完整性校验：文件被篡改会解密失败而不是悄悄返回垃圾。
 */

export type SecretName =
  | 'OPENAI_API_KEY' | 'OPENAI_COMPAT_API_KEY' | 'DEEPSEEK_API_KEY' | 'DASHSCOPE_API_KEY'
  | 'ALLNET_API_KEY' | 'ANTHROPIC_API_KEY' | 'GEMINI_API_KEY' | 'SOURCE_PROFILER_API_KEY'
  | 'TELEGRAM_API_ID' | 'TELEGRAM_API_HASH' | 'TELEGRAM_PHONE';

export const SECRET_NAMES: SecretName[] = [
  'OPENAI_API_KEY', 'OPENAI_COMPAT_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY',
  'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'SOURCE_PROFILER_API_KEY', 'ALLNET_API_KEY',
  'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_PHONE',
];

/** 非密钥的普通设置，与密钥同文件但不加密语义（仍随文件一起加密落盘）。 */
export type Settings = {
  /** L1 默认供应商；aiProvider 保留用于旧版本保管库兼容。 */
  aiProvider?: string;
  l1Provider?: string;
  l1Model?: string; l2Model?: string; l3Model?: string;
  l2Provider?: string; l3Provider?: string;
  l1BaseUrl?: string; l2BaseUrl?: string; l3BaseUrl?: string;
  sourceProfilerProvider?: string; sourceProfilerModel?: string;
  sourceProfilerBaseUrl?: string; sourceProfilerCredentialRef?: string;
  sourceProfilerTemperature?: string; sourceProfilerReasoningEffort?: string;
  sourceProfilerMaxInputChars?: string; sourceProfilerMaxOutputTokens?: string;
  sourceProfilerTimeoutMs?: string; sourceProfilerRetryPolicy?: string;
  sourceProfilerFallbackProfile?: string; sourceProfilerEnabled?: string;
  telegramProvider?: string; telegramModel?: string; telegramBaseUrl?: string;
};

export type Vault = { secrets: Partial<Record<SecretName, string>>; settings: Settings };

const EMPTY: Vault = { secrets: {}, settings: {} };

function masterKey(): Buffer | null {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) return null;
  // 允许 base64 或任意口令；统一派生成 32 字节
  return createHash('sha256').update(raw).digest();
}

export function vaultPath(dir?: string): string {
  return process.env.SECRETS_PATH
    ?? join(dir ?? process.env.SECRETS_DIR ?? '/var/lib/briefing', 'secrets.enc');
}

export class VaultLockedError extends Error {
  constructor() { super('未设置 APP_ENCRYPTION_KEY，密钥保管库不可用'); this.name = 'VaultLockedError'; }
}

export function loadVault(path = vaultPath()): Vault {
  const key = masterKey();
  if (!key) throw new VaultLockedError();
  if (!existsSync(path)) return structuredClone(EMPTY);

  const blob = JSON.parse(readFileSync(path, 'utf8'));
  if (blob.v !== 1) throw new Error(`不支持的保管库版本 ${blob.v}`);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  try {
    const plain = Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
    const v = JSON.parse(plain) as Vault;
    return { secrets: v.secrets ?? {}, settings: v.settings ?? {} };
  } catch {
    // GCM 校验失败：主密钥不对，或文件被篡改。绝不静默返回空保管库 ——
    // 那会让系统"看起来正常"地丢掉全部密钥。
    throw new Error('保管库解密失败：APP_ENCRYPTION_KEY 不匹配或文件已损坏/被篡改');
  }
}

export function saveVault(v: Vault, path = vaultPath()): void {
  const key = masterKey();
  if (!key) throw new VaultLockedError();
  mkdirSync(dirname(path), { recursive: true });
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(v), 'utf8'), c.final()]);
  const blob = JSON.stringify({ v: 1, iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') });
  // 先写临时文件再原子替换，避免写一半断电导致保管库损坏
  const tmp = path + '.tmp';
  writeFileSync(tmp, blob, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function setSecret(name: SecretName, value: string, path = vaultPath()): void {
  const v = loadVault(path);
  const trimmed = value.trim();
  if (trimmed) v.secrets[name] = trimmed; else delete v.secrets[name];
  saveVault(v, path);
}

export function setSettings(s: Settings, path = vaultPath()): void {
  const v = loadVault(path);
  v.settings = { ...v.settings, ...s };
  for (const [k, val] of Object.entries(v.settings))
    if (val === '' || val === undefined) delete (v.settings as any)[k];
  saveVault(v, path);
}

/** 页面展示用：只回末四位与长度，绝不回明文（PRD 16.2）。 */
export function maskedSecrets(path = vaultPath()): Array<{ name: SecretName; set: boolean; hint: string }> {
  let v: Vault;
  try { v = loadVault(path); } catch { v = structuredClone(EMPTY); }
  return SECRET_NAMES.map(name => {
    const val = v.secrets[name];
    return { name, set: !!val,
             hint: val ? (name.startsWith('TELEGRAM_') ? '••••••••' : `${'•'.repeat(Math.min(12, Math.max(0, val.length - 4)))}${val.slice(-4)}`) : '' };
  });
}

/**
 * 解析生效值：环境变量优先于保管库。
 * 这样运维仍可用 env 临时覆盖，而不必先改保管库。
 */
export function resolveSecret(name: SecretName, path = vaultPath()): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  try { return loadVault(path).secrets[name]; } catch { return undefined; }
}

export function resolveSettings(path = vaultPath()): Settings {
  let s: Settings = {};
  try { s = loadVault(path).settings; } catch { /* 保管库不可用时退回纯 env */ }
  return {
    aiProvider: process.env.AI_PROVIDER ?? s.aiProvider,
    l1Provider: process.env.AI_L1_PROVIDER ?? s.l1Provider ?? s.aiProvider,
    l1Model: process.env.AI_L1_MODEL ?? s.l1Model,
    l2Model: process.env.AI_L2_MODEL ?? s.l2Model,
    l3Model: process.env.AI_L3_MODEL ?? s.l3Model,
    l2Provider: process.env.AI_L2_PROVIDER ?? s.l2Provider,
    l3Provider: process.env.AI_L3_PROVIDER ?? s.l3Provider,
    l1BaseUrl: process.env.AI_L1_BASE_URL ?? s.l1BaseUrl,
    l2BaseUrl: process.env.AI_L2_BASE_URL ?? s.l2BaseUrl,
    l3BaseUrl: process.env.AI_L3_BASE_URL ?? s.l3BaseUrl,
    sourceProfilerProvider: process.env.SOURCE_PROFILER_PROVIDER ?? s.sourceProfilerProvider ?? 'mock',
    sourceProfilerModel: process.env.SOURCE_PROFILER_MODEL ?? s.sourceProfilerModel ?? 'mock-profiler',
    sourceProfilerBaseUrl: process.env.SOURCE_PROFILER_BASE_URL ?? s.sourceProfilerBaseUrl,
    sourceProfilerCredentialRef: process.env.SOURCE_PROFILER_CREDENTIAL_REF ?? s.sourceProfilerCredentialRef ?? 'SOURCE_PROFILER_API_KEY',
    sourceProfilerTemperature: process.env.SOURCE_PROFILER_TEMPERATURE ?? s.sourceProfilerTemperature ?? '0.1',
    sourceProfilerReasoningEffort: process.env.SOURCE_PROFILER_REASONING_EFFORT ?? s.sourceProfilerReasoningEffort,
    sourceProfilerMaxInputChars: process.env.SOURCE_PROFILER_MAX_INPUT_CHARS ?? s.sourceProfilerMaxInputChars ?? '24000',
    sourceProfilerMaxOutputTokens: process.env.SOURCE_PROFILER_MAX_OUTPUT_TOKENS ?? s.sourceProfilerMaxOutputTokens ?? '1800',
    sourceProfilerTimeoutMs: process.env.SOURCE_PROFILER_TIMEOUT_MS ?? s.sourceProfilerTimeoutMs ?? '30000',
    sourceProfilerRetryPolicy: process.env.SOURCE_PROFILER_RETRY_POLICY ?? s.sourceProfilerRetryPolicy ?? '1',
    sourceProfilerFallbackProfile: process.env.SOURCE_PROFILER_FALLBACK_PROFILE ?? s.sourceProfilerFallbackProfile,
    sourceProfilerEnabled: process.env.SOURCE_PROFILER_ENABLED ?? s.sourceProfilerEnabled ?? 'true',
  };
}

/** 供 CLI 在启动时把保管库内容注入 process.env，让下游代码无感。 */
export function hydrateEnv(path = vaultPath()): { loaded: string[]; error?: string } {
  try {
    const v = loadVault(path);
    const loaded: string[] = [];
    for (const [k, val] of Object.entries(v.secrets))
      if (val && !process.env[k]) { process.env[k] = val; loaded.push(k); }
    const s = v.settings;
    const map: Array<[string, string | undefined]> = [
      ['AI_PROVIDER', s.aiProvider], ['AI_L1_PROVIDER', s.l1Provider],
      ['AI_L1_MODEL', s.l1Model],
      ['AI_L2_MODEL', s.l2Model], ['AI_L3_MODEL', s.l3Model],
      ['AI_L2_PROVIDER', s.l2Provider], ['AI_L3_PROVIDER', s.l3Provider],
      ['AI_L1_BASE_URL', s.l1BaseUrl], ['AI_L2_BASE_URL', s.l2BaseUrl],
      ['AI_L3_BASE_URL', s.l3BaseUrl],
      ['SOURCE_PROFILER_PROVIDER', s.sourceProfilerProvider],
      ['SOURCE_PROFILER_MODEL', s.sourceProfilerModel],
      ['SOURCE_PROFILER_BASE_URL', s.sourceProfilerBaseUrl],
      ['SOURCE_PROFILER_CREDENTIAL_REF', s.sourceProfilerCredentialRef],
      ['SOURCE_PROFILER_TEMPERATURE', s.sourceProfilerTemperature],
      ['SOURCE_PROFILER_REASONING_EFFORT', s.sourceProfilerReasoningEffort],
      ['SOURCE_PROFILER_MAX_INPUT_CHARS', s.sourceProfilerMaxInputChars],
      ['SOURCE_PROFILER_MAX_OUTPUT_TOKENS', s.sourceProfilerMaxOutputTokens],
      ['SOURCE_PROFILER_TIMEOUT_MS', s.sourceProfilerTimeoutMs],
      ['SOURCE_PROFILER_RETRY_POLICY', s.sourceProfilerRetryPolicy],
      ['SOURCE_PROFILER_FALLBACK_PROFILE', s.sourceProfilerFallbackProfile],
      ['SOURCE_PROFILER_ENABLED', s.sourceProfilerEnabled],
    ];
    for (const [k, val] of map)
      if (val && !process.env[k]) { process.env[k] = val; loaded.push(k); }
    return { loaded };
  } catch (e: any) {
    return { loaded: [], error: String(e?.message ?? e) };
  }
}

/** 校验主密钥是否能解开现有保管库（用于启动自检）。 */
export function vaultHealthy(path = vaultPath()): { ok: boolean; reason?: string } {
  if (!process.env.APP_ENCRYPTION_KEY) return { ok: false, reason: '未设置 APP_ENCRYPTION_KEY' };
  if (!existsSync(path)) return { ok: true };
  try { loadVault(path); return { ok: true }; }
  catch (e: any) { return { ok: false, reason: String(e?.message ?? e) }; }
}

void timingSafeEqual;
