/**
 * 供应商中立的模型调用接口。
 *
 * 上层（重试、升级、预算、evaluations 落库）只依赖这里的类型，
 * 换供应商 = 换一个 Provider 实现，上层零改动。
 *
 * 五家主流厂商实际只有三种线路格式：
 *   · OpenAI 兼容  —— OpenAI / DeepSeek / Qwen(DashScope 兼容模式) / 及大量其他
 *   · Anthropic    —— Messages API，原生 output_config.format 结构化输出
 *   · Gemini       —— generateContent + responseSchema
 */

export type ProviderName = 'mock' | 'openai' | 'deepseek' | 'qwen' | 'anthropic' | 'gemini';

/** 归一化后的用量口径。各家字段名不同，由适配器负责翻译。 */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  /** 命中缓存的输入 token（计费更低）。不支持的厂商填 0。 */
  cachedInputTokens: number;
  /** 写入缓存的输入 token（Anthropic 有此口径，其余为 0）。 */
  cacheWriteTokens: number;
};

export type CompleteRequest = {
  /** 稳定前缀：系统规则 + Schema 说明。放最前以命中各家的 Prompt Caching。 */
  systemPrompt: string;
  /** 易变部分：候选数据。放在稳定前缀之后。 */
  userContent: string;
  /** 强制输出结构。各家用各自机制落实。 */
  schema: JsonSchema;
  /** Schema 名称，部分厂商要求。 */
  schemaName: string;
  maxOutputTokens: number;
  /** 是否请求缓存稳定前缀。 */
  cachePrefix?: boolean;
};

export type CompleteResult = {
  /** 已解析的 JSON。是否经过严格校验取决于 strictness。 */
  data: unknown;
  usage: Usage;
  /** 供应商侧的响应标识，用于审计追溯（PRD 15 要求）。 */
  responseId: string;
  model: string;
  /** 原始文本，Schema 校验失败时用于诊断。 */
  rawText?: string;
  /** 供应商是否声明拒答/截断。 */
  stopReason?: string;
};

/**
 * 结构化输出的强度。决定上层要不要额外做 Schema 校验与重试。
 *   strict  —— 供应商保证符合 JSON Schema（OpenAI Structured Outputs / Anthropic / Gemini）
 *   json    —— 仅保证是合法 JSON，不保证符合 schema（DeepSeek / 部分 Qwen 模型）
 *   none    —— 无保证，纯靠提示词与解析兜底（本地小模型）
 */
export type Strictness = 'strict' | 'json' | 'none';

export interface Provider {
  readonly name: ProviderName;
  readonly model: string;
  /** 本供应商+模型对结构化输出的保证强度。 */
  readonly strictness: Strictness;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

export type ProviderConfig = {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  /** OpenAI 兼容厂商的自定义端点。 */
  baseUrl?: string;
  timeoutMs?: number;
  /** 强制覆盖 strictness（例如某 Qwen 模型支持 json_schema）。 */
  strictness?: Strictness;
};

export type JsonSchema = Record<string, unknown>;

/** 供应商调用失败的归一化错误。 */
export class ProviderError extends Error {
  kind: 'rate_limited' | 'auth' | 'timeout' | 'bad_request' | 'server' | 'network' | 'refusal';
  status?: number;
  retryable: boolean;
  constructor(kind: ProviderError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryable = kind === 'rate_limited' || kind === 'server' ||
                     kind === 'timeout' || kind === 'network';
  }
}
