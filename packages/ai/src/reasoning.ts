/**
 * Chat Completions 的 reasoning_effort（思考程度）。
 *
 * 只对官方文档已核实、且供应商类型为 openai / openai_compatible 的模型发送。
 * 未核实的模型（Grok、Gemini、DeepSeek、通义、Anthropic，以及未知的兼容模型）
 * 不发送该参数。调用方若显式指定了取值，必须拒绝，不能悄悄丢掉。
 *
 * 取值依据（2026-11-16 官方文档）：
 * - https://developers.openai.com/api/docs/models/gpt-6.1-terra
 *   gpt-6.1-terra：none、low、medium（默认）、high、xhigh、max
 * - https://developers.openai.com/api/docs/models/gpt-6-astra
 *   gpt-6-astra：low、medium、high、xhigh、max（不支持 none）
 * - https://developers.openai.com/api/docs/models/gpt-6.1-sol
 *   gpt-6.1-sol：low、medium（默认）、high、xhigh、max（不支持 none、minimal）
 * - https://developers.openai.com/api/docs/guides/latest-model
 *   gpt-6-sol、gpt-6-luna 支持 none；gpt-6-astra、gpt-6.1-sol 不支持 none
 * - https://developers.openai.com/api/docs/guides/deployment-checklist
 *   gpt-6-sol、gpt-6-luna：none、low、medium、high、xhigh、max
 * - https://developers.openai.com/api/docs/models/gpt-5
 *   gpt-5 与快照 gpt-5-2025-08-07：minimal、low、medium、high
 * - https://developers.openai.com/api/docs/guides/latest-model
 *   思考程度不是 none 时，不要发送 temperature、top_p、top_logprobs；
 *   Chat Completions 还不要发送 logprobs。
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export type ReasoningSupport = { efforts: readonly ReasoningEffort[] };

const TERRA: ReasoningSupport = { efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] };
const ASTRA: ReasoningSupport = { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
const SOL61: ReasoningSupport = { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
const SOL6: ReasoningSupport = { efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] };
const GPT5: ReasoningSupport = { efforts: ['minimal', 'low', 'medium', 'high'] };

/** 精确模型 ID。网关若写成 vendor/模型，只认斜线后的这一段，且只允许一个斜线。 */
export const VERIFIED_REASONING_MODELS: Record<string, ReasoningSupport> = {
  'gpt-6.1-terra': TERRA,
  'gpt-6-astra': ASTRA,
  'gpt-6.1-sol': SOL61,
  'gpt-6-sol': SOL6,
  'gpt-6-luna': SOL6,
  'gpt-5': GPT5,
  'gpt-5-2025-08-07': GPT5,
};

const SENDABLE_PROVIDER = new Set(['openai', 'openai_compatible']);

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function reasoningSupport(provider: string, model: string): ReasoningSupport | null {
  if (!SENDABLE_PROVIDER.has(provider)) return null;
  const id = model.trim();
  if (VERIFIED_REASONING_MODELS[id]) return VERIFIED_REASONING_MODELS[id]!;
  const slash = id.indexOf('/');
  if (slash > 0 && slash === id.lastIndexOf('/')) {
    const rest = id.slice(slash + 1);
    if (VERIFIED_REASONING_MODELS[rest]) return VERIFIED_REASONING_MODELS[rest]!;
  }
  return null;
}

/** 显式取值不能用于该供应商/模型时，返回可展示的原因；可以用则返回 null。 */
export function reasoningRejection(provider: string, model: string, effort: string): string | null {
  if (!isReasoningEffort(effort)) return `思考程度「${effort}」不是允许的取值`;
  const support = reasoningSupport(provider, model);
  if (!support) {
    return `模型「${model}」在当前供应商类型下未核实支持 reasoning_effort，不能保存「${effort}」。请改为不发送；系统不会悄悄丢掉这个设置`;
  }
  if (!support.efforts.includes(effort)) {
    return `模型「${model}」的思考程度只支持 ${support.efforts.join('、')}，不支持「${effort}」`;
  }
  return null;
}
