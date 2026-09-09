import type { JsonSchema, Provider } from './types.ts';
import { validate } from './schema.ts';

export const SOURCE_PROFILER_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['source_type','content_domain','publisher_type','officiality','default_category',
    'quality_profile','freshness_profile','fulltext_requirement','dedupe_strategy','risk_flags',
    'recommended_rule_profile','proposed_rule_diff','evidence_sample_ids','confidence','capability_gap'],
  properties: {
    source_type: { type: 'string', enum: ['rss','atom','rsshub','fixed_web','telegram_web','unknown'] },
    content_domain: { type: 'string' },
    publisher_type: { type: 'string' },
    officiality: { type: 'string', enum: ['official','reputable','community','unknown'] },
    default_category: { type: 'string' },
    quality_profile: { type: 'string' },
    freshness_profile: { type: 'string' },
    fulltext_requirement: { type: 'string', enum: ['none','recommended','required'] },
    dedupe_strategy: { type: 'string' },
    risk_flags: { type: 'array', items: { type: 'string' } },
    recommended_rule_profile: { type: 'string' },
    proposed_rule_diff: { type: 'array', items: { type: 'object' } },
    evidence_sample_ids: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    capability_gap: { type: ['string','null'] },
  },
};

const SYSTEM = `You are Source Profiler for a daily RSS briefing system. Analyze only the supplied URL metadata and samples. Return JSON matching the schema exactly. Never invent facts not supported by samples. Produce a conservative rule diff with matcher/action/priority/scope/reason_code/exceptions/must_keep when useful. If parser or rule capability is missing, set capability_gap instead of suggesting code edits.`;

export type SourceProfilerInput = {
  url: string; parser: string; name: string;
  metadata: Record<string, unknown>; samples: Array<Record<string, unknown>>;
};

export async function runSourceProfiler(provider: Provider, input: SourceProfilerInput) {
  const userContent = JSON.stringify(input);
  const result = await provider.complete({ systemPrompt: SYSTEM, userContent,
    schema: SOURCE_PROFILER_SCHEMA, schemaName: 'source_profiler', maxOutputTokens: 1800, cachePrefix: true });
  const errors = validate(result.data, SOURCE_PROFILER_SCHEMA);
  if (errors.length) throw new Error(`Source Profiler 输出不符合结构化 schema: ${errors.slice(0, 4).join('; ')}`);
  return { ...(result.data as any), responseId: result.responseId, model: result.model, usage: result.usage };
}
